/**
 * Video Creation Workbench — project store (filesystem persistence).
 *
 * This module is the single authority for reading and writing Project JSON
 * and the per-project directory layout. Every mutation goes through
 * `atomic-fs`'s tmp → fsync → rename scaffold so readers never observe a
 * half-written file. Callers never hand-roll paths — they go through
 * `path-safety::resolveProjectFile` so every filesystem access is
 * containment-checked against `data/projects/`.
 *
 * Responsibilities:
 *   - Generate collision-free project IDs (`proj_{ms}_{6 alnum}`).
 *   - Create and validate the on-disk Project JSON (root aggregate).
 *   - Persist stage artefacts (brief, storyboard, composition HTML, audio).
 *   - Delete projects completely — JSON, per-project dir, and published MP4
 *     assets (`public/videos/project-{id}.mp4` + `.prev.mp4` + `.poster.jpg`).
 *   - List projects as lightweight `ProjectSummary` rows for the dashboard.
 *
 * Store invariants (design §Store Invariants, Properties 6 / 7 / 8):
 *   1. `updatedAt` is non-decreasing between successful writes. The MVP
 *      implementation sets `updatedAt = new Date().toISOString()` on every
 *      write without reading the previous value; monotonicity is ensured in
 *      practice by wall-clock advancement. A stronger guarantee
 *      (read-prev → take-max) is deferred — see the note in `writeProject`.
 *   2. Writes are atomic via tmp → fsync → rename (delegated to atomic-fs).
 *   3. `schemaVersion === 1`; any other value surfaces as
 *      `SCHEMA_VERSION_MISMATCH`.
 *   4. String fields are control-char-scrubbed by `schemas.ts` before
 *      persistence (zod refine via `safeStr`).
 *   5. Every resolved path is asserted to stay under the data directory.
 */

import path from "node:path";
import { readdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import {
  atomicWriteBuffer,
  atomicWriteJson,
  ensureDir,
  fileExists,
  readFileSafe,
  removeTree,
} from "./atomic-fs";
import {
  DATA_DIR,
  DEFAULT_LOCALE,
  LIMITS,
  REGEX,
  SCHEMA_VERSION,
  STAGE_DIRS,
  VIDEO_DIR,
} from "./constants";
import { ErrorCode, WorkbenchError, isWorkbenchError } from "./errors";
import {
  assertUnderDataDir,
  assertValidProjectId,
  getDataDirAbs,
  resolveProjectFile,
} from "./path-safety";
import {
  BriefSchema,
  ProjectSchema,
  StoryboardSchema,
} from "./schemas";
import { initialStageStatusMap } from "./state-machine";
import type {
  ArtifactPaths,
  Brief,
  CreateProjectInput,
  DeleteReport,
  Project,
  ProjectSummary,
  Storyboard,
  TemplateSource,
} from "./types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Match the `{projectId}.json` file name shape under `data/projects/`. */
const PROJECT_JSON_FILE = /^proj_[0-9]+_[a-z0-9]{6}\.json$/;

/** Absolute path of the video directory, resolved against `process.cwd()`. */
function getVideoDirAbs(): string {
  return path.resolve(process.cwd(), VIDEO_DIR);
}

/** Absolute path of a project's `{projectId}.json` file under `data/projects/`. */
function projectJsonPath(projectId: string): string {
  const abs = path.resolve(getDataDirAbs(), `${projectId}.json`);
  assertUnderDataDir(abs);
  return abs;
}

/** Build a 6-char lowercase alphanumeric token for project-ID suffixes. */
function randomProjectSuffix(): string {
  // 4 random bytes → 8 hex chars → slice(0, 6). Hex charset satisfies
  // `[a-z0-9]{6}` (all lowercase, digits + a-f).
  return randomBytes(4).toString("hex").slice(0, 6);
}

// ---------------------------------------------------------------------------
// Project ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh Project ID of the form `proj_{ms-timestamp}_{6 alnum}`,
 * retrying up to `LIMITS.PROJECT_ID_RETRY` times on collision with either
 * an existing `{id}.json` file or a pre-existing `{id}/` directory.
 *
 * Collisions are astronomically unlikely at this shape (≈ 1.7e7 suffix
 * space × ms-precision clock), but the retry budget is the spec's
 * defence-in-depth.
 */
export async function generateProjectId(): Promise<string> {
  const dataDir = getDataDirAbs();
  for (let attempt = 0; attempt < LIMITS.PROJECT_ID_RETRY; attempt++) {
    const candidate = `proj_${Date.now()}_${randomProjectSuffix()}`;
    // Double-check shape — defensive belt-and-braces against any future
    // change to the suffix generator.
    if (!REGEX.PROJECT_ID.test(candidate)) continue;

    const jsonAbs = path.resolve(dataDir, `${candidate}.json`);
    const dirAbs = path.resolve(dataDir, candidate);

    const [jsonTaken, dirTaken] = await Promise.all([
      fileExists(jsonAbs),
      fileExists(dirAbs),
    ]);
    if (!jsonTaken && !dirTaken) return candidate;
  }
  throw new WorkbenchError(
    ErrorCode.WRITE_FAILED,
    "Could not generate unique project ID",
    { attempts: LIMITS.PROJECT_ID_RETRY },
  );
}

// ---------------------------------------------------------------------------
// Directory scaffolding
// ---------------------------------------------------------------------------

/**
 * Create the per-project directory skeleton:
 *   - `data/projects/{projectId}/`
 *   - `data/projects/{projectId}/composition/`
 *   - `data/projects/{projectId}/composition/assets/` (+ `.gitkeep`)
 *   - `data/projects/{projectId}/composition/fonts/`  (+ `.gitkeep`)
 *   - `data/projects/{projectId}/logs/`
 *
 * Idempotent: pre-existing directories are not an error. `.gitkeep` stubs
 * are written as empty files via `atomicWriteBuffer` so they survive git
 * clean without piggy-backing on a user's global ignore rules.
 */
export async function initProjectDirs(projectId: string): Promise<void> {
  assertValidProjectId(projectId);

  const root = resolveProjectFile(projectId);
  const compositionDir = resolveProjectFile(projectId, STAGE_DIRS.COMPOSITION);
  const assetsDir = resolveProjectFile(
    projectId,
    STAGE_DIRS.COMPOSITION,
    STAGE_DIRS.ASSETS,
  );
  const fontsDir = resolveProjectFile(
    projectId,
    STAGE_DIRS.COMPOSITION,
    STAGE_DIRS.FONTS,
  );
  const logsDir = resolveProjectFile(projectId, STAGE_DIRS.LOGS);

  await ensureDir(root);
  await ensureDir(compositionDir);
  await ensureDir(assetsDir);
  await ensureDir(fontsDir);
  await ensureDir(logsDir);

  // .gitkeep stubs so the tree round-trips through git even when empty.
  await atomicWriteBuffer(path.join(assetsDir, ".gitkeep"), Buffer.alloc(0));
  await atomicWriteBuffer(path.join(fontsDir, ".gitkeep"), Buffer.alloc(0));
}

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

/**
 * Build the initial `ArtifactPaths` snapshot for a brand-new project.
 * All stage artefacts start null / empty — stages fill them in as they run.
 */
function initialArtifacts(): ArtifactPaths {
  return {
    briefPath: null,
    storyboardPath: null,
    compositionDir: null,
    indexHtmlPath: null,
    hyperframesJsonPath: null,
    audioPaths: [],
    videoPath: null,
  };
}

/**
 * Create a new Project end-to-end:
 *   1. Generate a unique ID.
 *   2. Scaffold the per-project directory tree.
 *   3. Persist the initial Project JSON at `data/projects/{id}.json`.
 *
 * Template copying is NOT done here — the Route handler wires
 * `template-manager::deepCopyTemplate` between step 2 and step 3 so the
 * template contents land under `composition/` before the JSON is
 * committed. That keeps `project-store` free of template concerns.
 *
 * On any failure after step 1, a best-effort `deleteProject(id)` runs to
 * roll back the partial creation before the original error propagates.
 */
export async function createProject(
  input: CreateProjectInput,
  templateSource: TemplateSource,
): Promise<Project> {
  const projectId = await generateProjectId();
  try {
    const now = new Date().toISOString();
    const seedBrief = input.seedBrief ?? null;

    // Initial stage status: if a seed brief is present, mark "brief" as
    // already succeeded so the workbench UI opens directly at the
    // storyboard stage with the Brief tab populated.
    const stageStatus = initialStageStatusMap();
    if (seedBrief) {
      stageStatus.brief = {
        status: "succeeded",
        startedAt: now,
        finishedAt: now,
        attempts: 1,
      };
    }

    const project: Project = {
      schemaVersion: SCHEMA_VERSION,
      projectId,
      title: input.title,
      topic: input.topic,
      locale: input.locale ?? DEFAULT_LOCALE,
      stage: seedBrief ? "storyboard" : "brief",
      stageStatus,
      stageHistory: seedBrief
        ? [
            {
              fromStage: "brief",
              toStage: "storyboard",
              at: now,
              result: "success" as const,
              reason: "seeded from analysis",
            },
          ]
        : [],
      brief: seedBrief,
      storyboard: null,
      artifacts: {
        ...initialArtifacts(),
        ...(seedBrief ? { briefPath: "brief.json" } : {}),
      },
      templateSource,
      createdAt: now,
      updatedAt: now,
    };

    await initProjectDirs(projectId);
    if (seedBrief) {
      await writeBrief(projectId, seedBrief);
    }
    await writeProject(project);
    return project;
  } catch (e) {
    // Best-effort rollback so a partially-created project doesn't linger.
    try {
      await deleteProject(projectId);
    } catch {
      // ignore
    }
    throw e;
  }
}

/**
 * Map legacy 8-stage values to the current 5-stage schema.
 * "topic" → "brief" (before brief was generated)
 * "qa" → "render" (after render, before published)
 * "published" → "render" (treat as render-complete)
 */
function mapLegacyStage(stage: string): string {
  const legacyMap: Record<string, string> = {
    topic: "brief",
    qa: "render",
    published: "render",
  };
  return legacyMap[stage] ?? stage;
}

/**
 * Filter a stageStatus object from Neon to only include the 5 valid stages.
 * Legacy data may contain "topic", "qa", "published" from the old 8-stage schema.
 */
function filterStageStatus(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const validStages = new Set(["brief", "storyboard", "composition", "audio", "render"]);
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([k]) => validStages.has(k))
  );
}

/**
 * Filter stageHistory entries to only include transitions between valid stages.
 * Legacy entries with "topic", "qa", "published" are dropped.
 */
function filterStageHistory(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const validStages = new Set(["brief", "storyboard", "composition", "audio", "render"]);
  return raw.filter((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    return validStages.has(e.fromStage as string) && validStages.has(e.toStage as string);
  });
}

/**
 * Read and validate the Project at `data/projects/{projectId}.json`.
 *
 * Error taxonomy:
 *   - Missing file → `PROJECT_NOT_FOUND` (404).
 *   - Unparseable JSON → `READ_FAILED` (500) with `{ path }`.
 *   - `schemaVersion !== 1` → `SCHEMA_VERSION_MISMATCH` (409) with
 *     `{ found, expected }`.
 *   - Zod validation failure → `READ_FAILED` (500) with `{ path, issues }`.
 */
export async function readProject(projectId: string): Promise<Project> {
  assertValidProjectId(projectId);

  // Phase 2: try Neon first
  if (process.env.DATABASE_URL) {
    try {
      const { sqlOne } = await import("@/lib/db");
      const row = await sqlOne<{
        project_id: string;
        schema_version: number;
        title: string;
        topic: string;
        locale: string;
        stage: string;
        stage_status: unknown;
        stage_history: unknown;
        brief: unknown;
        artifacts: unknown;
        template_source: unknown;
        created_at: string;
        updated_at: string;
      }>`
        SELECT project_id, schema_version, title, topic, locale, stage,
               stage_status, stage_history, brief, artifacts,
               template_source,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
               to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
        FROM content_analyzer.projects
        WHERE project_id = ${projectId}
      `;
      if (!row) {
        throw new WorkbenchError(ErrorCode.PROJECT_NOT_FOUND, "Project not found", { projectId });
      }
      // Reconstruct storyboard from scenes table
      const { sql: dbSql } = await import("@/lib/db");
      const sceneRows = await dbSql<{
        scene_id: string;
        scene_index: number;
        title: string;
        narration: string;
        duration_sec: number;
        voice: string;
        qa_note: string;
        audio_path: string | null;
        updated_at: string;
      }>`
        SELECT scene_id, scene_index, title, narration, duration_sec,
               voice, qa_note, audio_path,
               to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
        FROM content_analyzer.scenes
        WHERE project_id = ${projectId}
        ORDER BY scene_index
      `;
      const storyboard = sceneRows.length > 0
        ? {
            scenes: sceneRows.map((s) => ({
              sceneId: s.scene_id,
              index: s.scene_index,
              title: s.title,
              narration: s.narration,
              durationSec: s.duration_sec,
              voice: s.voice,
              qaNote: s.qa_note,
              audioPath: s.audio_path,
              updatedAt: s.updated_at,
            })),
          }
        : null;

      const raw = {
        schemaVersion: row.schema_version,
        projectId: row.project_id,
        title: row.title,
        topic: row.topic,
        locale: row.locale,
        // Map legacy stages to valid 5-stage values
        stage: mapLegacyStage(row.stage),
        // Filter out legacy stage keys (topic/qa/published) from old 8-stage data
        // so the 5-stage StageStatusMapSchema validates correctly.
        stageStatus: filterStageStatus(row.stage_status),
        stageHistory: filterStageHistory(row.stage_history),
        brief: row.brief,
        storyboard,
        artifacts: row.artifacts,
        templateSource: row.template_source,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };

      const result = ProjectSchema.safeParse(raw);
      if (!result.success) {
        console.warn("[project-store] Neon row failed schema validation, issues:", JSON.stringify(result.error.issues.slice(0, 3)));
        console.warn("[project-store] raw.stage:", raw.stage, "raw.stageStatus keys:", Object.keys(raw.stageStatus as object));
        throw new Error("schema validation failed");
      }
      return result.data;
    } catch (e) {
      if (e instanceof WorkbenchError && e.code === ErrorCode.PROJECT_NOT_FOUND) throw e;
      console.warn("[project-store] Neon read failed, falling back to FS:", e instanceof Error ? e.message : e);
    }
  }

  // Local FS fallback
  const absPath = projectJsonPath(projectId);

  let raw: string;
  try {
    raw = await readFileSafe(absPath);
  } catch (e) {
    // atomic-fs surfaces ENOENT as WorkbenchError(READ_FAILED, "Not found").
    // Reclassify as PROJECT_NOT_FOUND so the route layer can return 404.
    if (isWorkbenchError(e) && e.details?.reason === "Not found") {
      throw new WorkbenchError(
        ErrorCode.PROJECT_NOT_FOUND,
        "Project not found",
        { projectId },
      );
    }
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new WorkbenchError(ErrorCode.READ_FAILED, "Invalid JSON", {
      path: absPath,
      reason: e instanceof Error ? e.message : String(e),
    });
  }

  // Schema-version gate BEFORE zod parse: a v2 file would fail zod with
  // a confusing literal-mismatch issue; surfacing the dedicated error code
  // gives callers a precise migration signal.
  const foundVersion =
    typeof parsed === "object" &&
    parsed !== null &&
    "schemaVersion" in parsed
      ? (parsed as { schemaVersion: unknown }).schemaVersion
      : undefined;
  if (foundVersion !== SCHEMA_VERSION) {
    throw new WorkbenchError(
      ErrorCode.SCHEMA_VERSION_MISMATCH,
      "Project schema version mismatch",
      { found: foundVersion, expected: SCHEMA_VERSION, path: absPath },
    );
  }

  const result = ProjectSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkbenchError(
      ErrorCode.READ_FAILED,
      "Project schema validation failed",
      { path: absPath, issues: result.error.issues },
    );
  }
  return result.data;
}

/**
 * Persist `project` at `data/projects/{projectId}.json` atomically.
 *
 * Pre-flight:
 *   - Refresh `updatedAt` to `new Date().toISOString()` (MVP monotonicity
 *     — see module docstring note).
 *   - Re-validate against `ProjectSchema`; a malformed in-memory project
 *     throws `READ_FAILED` (caller's bug, not a runtime data issue).
 */
export async function writeProject(project: Project): Promise<void> {
  assertValidProjectId(project.projectId);

  // MVP monotonicity strategy:
  //   We set `updatedAt` to the current wall-clock ISO string on every
  //   write. As long as the system clock advances between writes,
  //   `updatedAt` is strictly non-decreasing (Property 6: monotonic).
  //   Clock skew from an NTP correction could theoretically violate this
  //   — deferred until the property test reveals a failing scenario at
  //   which point we'd switch to a read-prev → take-max strategy.
  const next: Project = {
    ...project,
    updatedAt: new Date().toISOString(),
  };

  const validated = ProjectSchema.safeParse(next);
  if (!validated.success) {
    throw new WorkbenchError(
      ErrorCode.WRITE_FAILED,
      "Project failed schema validation before write",
      {
        projectId: project.projectId,
        issues: validated.error.issues,
      },
    );
  }

  const absPath = projectJsonPath(project.projectId);
  await atomicWriteJson(absPath, validated.data, { spaces: 2 });

  // Phase 1 dual-write: mirror to Neon (fire-and-forget, never throws)
  import("./neon-sync").then(({ syncProjectToNeon }) => {
    void syncProjectToNeon(validated.data);
  }).catch(() => {/* ignore import errors in test environments */});
}

/**
 * Remove every filesystem resource owned by `projectId`:
 *   - `data/projects/{id}.json`
 *   - `data/projects/{id}/`  (recursive)
 *   - `public/videos/project-{id}.mp4`
 *   - `public/videos/project-{id}.prev.mp4`
 *   - `public/videos/project-{id}.poster.jpg`
 *
 * Missing paths are treated as success (nothing to remove). Partial
 * failures are aggregated into `DeleteReport.failed`; the caller decides
 * whether to surface `PARTIAL_DELETE` (500) or `204`.
 */
export async function deleteProject(projectId: string): Promise<DeleteReport> {
  assertValidProjectId(projectId);

  // Phase 2: also delete from Neon (fire-and-forget, non-blocking)
  if (process.env.DATABASE_URL) {
    import("@/lib/db").then(({ sql: dbSql }) => {
      void dbSql`DELETE FROM content_analyzer.projects WHERE project_id = ${projectId}`;
    }).catch(() => {/* ignore */});
  }

  const jsonAbs = projectJsonPath(projectId);
  const dirAbs = resolveProjectFile(projectId);

  const videoDir = getVideoDirAbs();
  const videoAbs = path.resolve(videoDir, `project-${projectId}.mp4`);
  const prevAbs = path.resolve(videoDir, `project-${projectId}.prev.mp4`);
  const posterAbs = path.resolve(videoDir, `project-${projectId}.poster.jpg`);

  // `removeTree` uses `fs.rm({ force: true })` so ENOENT counts as success.
  const reports = await Promise.all([
    removeTree(jsonAbs),
    removeTree(dirAbs),
    removeTree(videoAbs),
    removeTree(prevAbs),
    removeTree(posterAbs),
  ]);

  const succeeded: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const r of reports) {
    succeeded.push(...r.succeeded);
    failed.push(...r.failed);
  }
  return { succeeded, failed };
}

/**
 * Return a lightweight `ProjectSummary[]`, newest-first by `updatedAt`.
 *
 * Behaviour:
 *   - Missing `data/projects/` is NOT an error — returns `[]`.
 *   - Only files whose names match `{projectId}.json` are considered.
 *   - Individual corrupt / unreadable projects are skipped (logged via
 *     `console.warn`) rather than failing the whole listing.
 *   - `posterUrl` is the public URL when `public/videos/project-{id}.poster.jpg`
 *     exists on disk; otherwise `null`.
 *   - `videoUrl` mirrors `project.artifacts.videoPath` (already a public URL).
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  // Phase 2: try Neon first
  if (process.env.DATABASE_URL) {
    try {
      const { sql: dbSql } = await import("@/lib/db");
      const rows = await dbSql<{
        project_id: string;
        title: string;
        stage: string;
        updated_at: string;
        video_blob_url: string | null;
        artifacts: { videoPath?: string | null } | null;
      }>`
        SELECT project_id, title, stage,
               to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
               video_blob_url,
               artifacts
        FROM content_analyzer.projects
        ORDER BY updated_at DESC
      `;
      return rows.map((row) => ({
        projectId: row.project_id,
        title: row.title,
        stage: mapLegacyStage(row.stage) as ProjectSummary["stage"],
        updatedAt: row.updated_at,
        posterUrl: null, // poster not yet in Neon (Phase 3)
        videoUrl: row.video_blob_url ?? (row.artifacts?.videoPath ?? null),
      }));
    } catch (err) {
      console.warn("[project-store] Neon listProjects failed, falling back to FS:", err instanceof Error ? err.message : err);
    }
  }

  // Local FS fallback
  const dataDir = getDataDirAbs();
  await ensureDir(dataDir);

  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    // ensureDir just succeeded; if readdir fails now it's a real fs
    // problem — log and return empty rather than surface to the UI.
    return [];
  }

  const summaries: ProjectSummary[] = [];
  for (const name of entries) {
    if (!PROJECT_JSON_FILE.test(name)) continue;
    const projectId = name.slice(0, -".json".length);

    let project: Project;
    try {
      project = await readProject(projectId);
    } catch (e) {
      // Skip corrupted / malformed projects but don't swallow silently —
      // a dashboard admin should see them in server logs.
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(
        `[project-store] skipping project "${projectId}": ${reason}`,
      );
      continue;
    }

    const posterAbs = path.resolve(
      getVideoDirAbs(),
      `project-${projectId}.poster.jpg`,
    );
    const posterExists = await fileExists(posterAbs).catch(() => false);

    summaries.push({
      projectId: project.projectId,
      title: project.title,
      stage: project.stage,
      updatedAt: project.updatedAt,
      posterUrl: posterExists
        ? `/videos/project-${projectId}.poster.jpg`
        : null,
      videoUrl: project.artifacts.videoPath ?? null,
    });
  }

  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}

// ---------------------------------------------------------------------------
// Per-stage artefact writers
// ---------------------------------------------------------------------------

/**
 * Atomically persist `brief` at `data/projects/{projectId}/brief.json`.
 * Re-validates with `BriefSchema` so a bad in-memory brief surfaces before
 * the file is touched.
 */
export async function writeBrief(
  projectId: string,
  brief: Brief,
): Promise<void> {
  const absPath = resolveProjectFile(projectId, "brief.json");
  const validated = BriefSchema.safeParse(brief);
  if (!validated.success) {
    throw new WorkbenchError(
      ErrorCode.WRITE_FAILED,
      "Brief failed schema validation before write",
      { projectId, issues: validated.error.issues },
    );
  }
  await atomicWriteJson(absPath, validated.data, { spaces: 2 });
}

/**
 * Atomically persist `storyboard` at
 * `data/projects/{projectId}/storyboard.json`. Re-validates with
 * `StoryboardSchema`.
 */
export async function writeStoryboard(
  projectId: string,
  storyboard: Storyboard,
): Promise<void> {
  const absPath = resolveProjectFile(projectId, "storyboard.json");
  const validated = StoryboardSchema.safeParse(storyboard);
  if (!validated.success) {
    throw new WorkbenchError(
      ErrorCode.WRITE_FAILED,
      "Storyboard failed schema validation before write",
      { projectId, issues: validated.error.issues },
    );
  }
  await atomicWriteJson(absPath, validated.data, { spaces: 2 });
}

/**
 * Atomically persist LLM-produced composition HTML at
 * `data/projects/{projectId}/composition/index.html`.
 *
 * The buffer is encoded UTF-8; callers are expected to have already passed
 * the HTML through `html-scanner` for forbidden-token rejection.
 */
export async function writeCompositionHtml(
  projectId: string,
  html: string,
): Promise<void> {
  const absPath = resolveProjectFile(
    projectId,
    STAGE_DIRS.COMPOSITION,
    "index.html",
  );
  await atomicWriteBuffer(absPath, Buffer.from(html, "utf8"));

  // Sync index.html to Neon (fire-and-forget)
  import("./neon-sync").then(({ syncIndexHtmlToNeon }) => {
    void syncIndexHtmlToNeon(projectId, html);
  }).catch(() => {});
}

/**
 * Read `data/projects/{projectId}/composition/index.html` as UTF-8 text.
 * Surfaces missing files as `READ_FAILED` with reason `"Not found"` (via
 * `readFileSafe`); callers that want a 404 should reclassify.
 */
export async function readCompositionHtml(projectId: string): Promise<string> {
  const absPath = resolveProjectFile(
    projectId,
    STAGE_DIRS.COMPOSITION,
    "index.html",
  );
  return readFileSafe(absPath);
}

/**
 * Atomically persist a per-scene sub-composition HTML at
 * `data/projects/{projectId}/composition/{relPath}`.
 *
 * `relPath` MUST be a composition-relative path under `compositions/` —
 * typically produced by `sceneCompositionPath(scene)` from
 * `ai-generator.ts`. The path is run through `assertUnderDataDir` to keep
 * traversal attempts from escaping the project dir.
 *
 * Caller is responsible for having already passed the HTML through
 * `html-scanner` for forbidden-token rejection.
 */
export async function writeSceneCompositionHtml(
  projectId: string,
  relPath: string,
  html: string,
): Promise<void> {
  // Split the relative path into segments so `resolveProjectFile`'s
  // traversal guard fires on any `..` injection.
  const parts = relPath.split("/").filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new WorkbenchError(
      ErrorCode.WRITE_FAILED,
      "Scene composition path must not be empty",
    );
  }
  const absPath = resolveProjectFile(
    projectId,
    STAGE_DIRS.COMPOSITION,
    ...parts,
  );
  await atomicWriteBuffer(absPath, Buffer.from(html, "utf8"));

  // Sync scene HTML to Neon (fire-and-forget).
  // relPath format: "compositions/scene-NN-xxxxxx.html"
  // sceneId format: "sc_xxxxxxxx" where xxxxxx is the first 6 hex chars.
  // Extract the hex tail from the filename to match the scene row.
  const filename = parts[parts.length - 1]; // e.g. "scene-05-88ea72.html"
  const hexTailMatch = filename.match(/scene-\d+-([a-z0-9]{6})\.html$/);
  if (hexTailMatch) {
    const hexTail = hexTailMatch[1]; // e.g. "88ea72"
    import("./neon-sync").then(({ syncSceneHtmlToNeon }) => {
      // sceneId starts with "sc_" followed by 8 hex chars; the first 6 match hexTail
      void syncSceneHtmlToNeon(projectId, `sc_${hexTail}`, html);
    }).catch(() => {});
  }
}

/**
 * Remove every `.html` file under `composition/compositions/` for the
 * given project. Used before a full regeneration so stale scene files
 * from a previous run don't linger alongside the fresh ones (which would
 * trip `multiple_root_compositions` on lint if the old scene IDs differ).
 *
 * Best-effort: if the directory is missing, this is a no-op.
 */
export async function clearSceneCompositions(projectId: string): Promise<void> {
  const compositionsDir = resolveProjectFile(
    projectId,
    STAGE_DIRS.COMPOSITION,
    "compositions",
  );
  try {
    const entries = await readdir(compositionsDir);
    await Promise.all(
      entries
        .filter((name) => name.endsWith(".html"))
        .map(async (name) => {
          try {
            await rm(path.join(compositionsDir, name));
          } catch {
            // ignore — cleanup is best-effort
          }
        }),
    );
  } catch {
    // directory missing — nothing to clean
  }
}

/**
 * Atomically persist a scene's TTS audio buffer.
 *
 * - Local: writes to `data/projects/{projectId}/composition/assets/scene-{index}.mp3`
 * - Vercel: stores base64-encoded MP3 in Neon `scenes.audio_data`
 *
 * `index` is the 1-based Scene index — not the sceneId — so audio files
 * line up with the positional slots the composition HTML wires via
 * `<audio src="assets/scene-N.mp3">`.
 */
export async function writeAudioFile(
  projectId: string,
  index: number,
  buf: Buffer,
): Promise<void> {
  if (!Number.isInteger(index) || index < 1) {
    throw new WorkbenchError(
      ErrorCode.WRITE_FAILED,
      "Scene index must be a positive integer",
      { projectId, index },
    );
  }

  const { isLocalEnv } = await import("@/lib/env");
  if (!isLocalEnv()) {
    // On Vercel: persist to Neon (no local FS available)
    const { syncAudioToNeon } = await import("./neon-sync");
    await syncAudioToNeon(projectId, index, buf);
    return;
  }

  const absPath = resolveProjectFile(
    projectId,
    STAGE_DIRS.COMPOSITION,
    STAGE_DIRS.ASSETS,
    `scene-${index}.mp3`,
  );
  await atomicWriteBuffer(absPath, buf);
}

// Silence unused-import warning if DATA_DIR ever becomes unused after
// refactors — keeping the symbol re-exported via `getDataDirAbs` makes
// the dependency on `constants.DATA_DIR` explicit. The void expression
// below is a no-op at runtime.
void DATA_DIR;
