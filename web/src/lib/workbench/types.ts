/**
 * Video Creation Workbench — core TypeScript types.
 *
 * These types mirror the on-disk JSON shape of a Project (see design.md §Data
 * Models). Runtime validation lives in `./schemas.ts` (zod). Keep this file in
 * sync with the schemas — the schemas are the single source of truth at the
 * API boundary; these types are what the rest of the app programs against.
 *
 * Semantic constraints that TypeScript cannot express are documented inline:
 * they MUST be enforced at runtime by schemas or by the responsible module
 * (project-store, state-machine, scene-reindexer, etc.).
 */

// ---------------------------------------------------------------------------
// Stage / stage status
// ---------------------------------------------------------------------------

/**
 * The 8 stages of the project state machine, in canonical order.
 * Transitions are authoritative — see `state-machine.ts`.
 */
export type Stage =
  | "topic"
  | "brief"
  | "storyboard"
  | "composition"
  | "audio"
  | "render"
  | "qa"
  | "published";

/** Lifecycle value of a single stage. Each stage has its own independent lifecycle. */
export type StageStatusValue =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

/**
 * Per-stage status. `startedAt` / `finishedAt` / `error` / `attempts` are
 * optional because they only appear in certain lifecycle states.
 */
export interface StageStatus {
  status: StageStatusValue;
  /** ISO 8601 UTC timestamp — set when the stage transitions to "running". */
  startedAt?: string;
  /** ISO 8601 UTC timestamp — set when the stage reaches a terminal state. */
  finishedAt?: string;
  error?: {
    /** Stable identifier, ≤64 chars (e.g. "LLM_TIMEOUT"). */
    code: string;
    /** Human-readable message; ≤500 chars (truncated by project-store). */
    message: string;
  };
  /** Incremented on each run; optional so fresh projects can omit it. */
  attempts?: number;
}

/** Map from every `Stage` to its current `StageStatus`. */
export type StageStatusMap = Record<Stage, StageStatus>;

/**
 * Append-only log entry written on every stage transition, including
 * regressions (`qa → storyboard|composition|audio`).
 */
export interface StageHistoryEntry {
  fromStage: Stage;
  toStage: Stage;
  /** ISO 8601 UTC timestamp. */
  at: string;
  /** Optional human-readable reason; ≤500 chars. Required for regressions. */
  reason?: string;
  result: "success" | "failure";
}

// ---------------------------------------------------------------------------
// Artifacts / template source
// ---------------------------------------------------------------------------

/**
 * Relative paths (under the per-project directory) for each generated
 * artifact. `videoPath` is the public-facing URL once rendered.
 *
 * NOTE: Paths MUST be validated to stay under `data/projects/{projectId}/`
 * (and `public/videos/` for `videoPath`) — enforced by project-store.
 */
export interface ArtifactPaths {
  /** Relative path, e.g. "brief.json". Null until brief generated. */
  briefPath: string | null;
  /** Relative path, e.g. "storyboard.json". Null until storyboard generated. */
  storyboardPath: string | null;
  /** Relative path, e.g. "composition". Null until composition scaffolded. */
  compositionDir: string | null;
  /** Relative path, e.g. "composition/index.html". */
  indexHtmlPath: string | null;
  /** Relative path, e.g. "composition/hyperframes.json". */
  hyperframesJsonPath: string | null;
  /** Ordered by `scene.index` (1-based). Default empty. */
  audioPaths: string[];
  /** Public-facing URL, e.g. "/videos/project-xxx.mp4". Null until rendered. */
  videoPath: string | null;
}

/**
 * Snapshot of the HyperFrames template the project was created from.
 * Captured at project creation time so subsequent template upgrades don't
 * silently change past projects.
 */
export interface TemplateSource {
  /** Template name, e.g. "linear-launch". */
  name: string;
  /** semver | commit-sha | "unknown". */
  version: string;
  /** Absolute path resolved at creation time. */
  sourcePath: string;
}

// ---------------------------------------------------------------------------
// QA notes
// ---------------------------------------------------------------------------

/**
 * QA feedback attached either to a specific scene or to the project.
 * Notes are append-only and drive scene rewrites.
 */
export interface QaNote {
  /** Format: `qan_{8hex}`. */
  noteId: string;
  /** Null = project-level note; otherwise references a `Scene.sceneId`. */
  sceneId: string | null;
  /** ≤2000 chars (control chars scrubbed). */
  text: string;
  author: "local";
  /** ISO 8601 UTC timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Brief / storyboard / scene
// ---------------------------------------------------------------------------

/** LLM-generated creative brief derived from the project topic. */
export interface Brief {
  /** 1–60 chars. */
  title: string;
  /** 1–200 chars. */
  audience: string;
  /** 3–5 entries, each 1–200 chars. */
  corePoints: string[];
  /** 1–60 chars. */
  tone: string;
  /** Integer, 20–180 seconds. */
  targetDurationSec: number;
  /** 1–200 chars. */
  suggestedStyle: string;
}

/** Azure Cognitive Services TTS voice name (e.g. "zh-CN-Xiaochen:DragonHDFlashLatestNeural"). Free-form string — Azure supports hundreds of voices. */
export type Voice = string;

/**
 * A single scene within a storyboard.
 *
 * NOTE: `index` MUST be 1-based and contiguous across a storyboard — enforced
 * at runtime by `scene-reindexer.ts`. `narration` is 1–280 chars when first
 * produced by the storyboard LLM, and may grow to ≤2000 chars post-rewrite.
 */
export interface Scene {
  /** Format: `sc_{8hex}`. */
  sceneId: string;
  /** 1-based, contiguous within its storyboard. */
  index: number;
  /** 1–40 chars. */
  title: string;
  /** 1–280 chars at storyboard time; up to 2000 after QA rewrite. */
  narration: string;
  /** 1–60 seconds. */
  durationSec: number;
  voice: Voice;
  /** Relative path, e.g. "assets/scene-{index}.mp3". Null until TTS runs. */
  audioPath: string | null;
  /** 0–2000 chars. QA note specific to this scene. */
  qaNote: string;
  /** ISO 8601 UTC timestamp. */
  updatedAt: string;
}

/**
 * Ordered list of scenes for a project.
 *
 * NOTE: `scenes.length` MUST be 3–20 — enforced by schema and by the scene
 * CRUD routes (`STORYBOARD_LIMIT` on violation).
 */
export interface Storyboard {
  scenes: Scene[];
}

// ---------------------------------------------------------------------------
// Project (root aggregate)
// ---------------------------------------------------------------------------

/**
 * Root aggregate persisted as `data/projects/{projectId}.json`.
 *
 * Store invariants (see design §Store Invariants, enforced by project-store):
 *   1. `updatedAt` is monotonic (non-decreasing) between successful writes.
 *   2. Writes are atomic via tmp → fsync → rename.
 *   3. `schemaVersion` is pinned to `1`; any other value returns
 *      `SCHEMA_VERSION_MISMATCH`.
 *   4. All string fields are control-char-scrubbed before persistence.
 *   5. `projectId` and every `sceneId` satisfy their respective regex.
 */
export interface Project {
  schemaVersion: 1;
  /** Regex: `^proj_[0-9]+_[a-z0-9]{6}$`. */
  projectId: string;
  /** 1–200 chars. */
  title: string;
  /** 1–500 chars. */
  topic: string;
  /** Defaults to `"zh-CN"`. */
  locale: "zh-CN" | "en-US";
  stage: Stage;
  stageStatus: StageStatusMap;
  stageHistory: StageHistoryEntry[];
  brief: Brief | null;
  storyboard: Storyboard | null;
  artifacts: ArtifactPaths;
  qaNotes: QaNote[];
  templateSource: TemplateSource;
  /** ISO 8601 UTC timestamp. */
  createdAt: string;
  /** ISO 8601 UTC timestamp (monotonic — see Store invariant 1). */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// API-shape helpers
// ---------------------------------------------------------------------------

/**
 * Lighter view of a project for the list endpoint (`GET /api/projects`).
 * Avoids sending the full storyboard/brief payload in list responses.
 */
export interface ProjectSummary {
  projectId: string;
  title: string;
  stage: Stage;
  /** ISO 8601 UTC timestamp. */
  updatedAt: string;
  /** Present when a render poster has been produced. */
  posterUrl?: string | null;
  /** Present when a final render is available. */
  videoUrl?: string | null;
}

/** Request body for `POST /api/projects`. */
export interface CreateProjectInput {
  /** 1–200 chars. */
  title: string;
  /** 1–500 chars. */
  topic: string;
  /** Defaults to `"zh-CN"` when omitted. */
  locale?: "zh-CN" | "en-US";
}

/**
 * Response body for `DELETE /api/projects/{id}`. When `failed` is non-empty
 * the route returns `500 PARTIAL_DELETE` and includes this report so the
 * caller can retry or clean up manually.
 */
export interface DeleteReport {
  /** Absolute or relative paths successfully removed. */
  succeeded: string[];
  /** Paths that could not be removed, with a reason each. */
  failed: Array<{ path: string; reason: string }>;
}

/**
 * Response body for `POST /api/projects/{id}/audio/generate`.
 *
 * Returned with `200` when all TTS calls succeeded, or `207 Multi-Status`
 * when at least one scene failed — in that case `failures` enumerates the
 * per-scene errors and the partial project is still persisted.
 */
export interface TTSBatchResult {
  scenes: Scene[];
  failures: Array<{
    sceneId: string;
    /** 1-based scene index at the time of the TTS call. */
    index: number;
    voice: Voice;
    error: { code: string; message: string };
  }>;
}

/**
 * Discriminated union of events pushed on the render SSE stream
 * (`GET /api/projects/{id}/render/stream`).
 *
 * Terminal events are `{ type: "stage", stage: "done" | "failed" }` — after
 * which the server closes the stream. Heartbeats are emitted every ~2 s to
 * keep the connection open even when no log lines arrive.
 */
export type RenderEvent =
  | {
      type: "stage";
      stage: "starting" | "rendering" | "encoding" | "done" | "failed";
      /** ISO 8601 UTC timestamp. */
      at: string;
    }
  | {
      type: "line";
      /** Raw stdout/stderr line from the renderer. */
      line: string;
      /** ISO 8601 UTC timestamp. */
      at: string;
    }
  | {
      type: "heartbeat";
      /** ISO 8601 UTC timestamp. */
      at: string;
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

/**
 * Canonical error envelope for all non-2xx API responses.
 * Routes MUST wrap errors in this shape so the client can uniformly surface
 * them (see design §API Contract).
 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    /** Free-form structured context (e.g. validation details, conflict list). */
    details?: Record<string, unknown>;
  };
}
