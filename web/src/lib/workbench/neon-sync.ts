/**
 * Workbench — Neon dual-write sync (Phase 1).
 *
 * Every write to the local filesystem also mirrors to Neon's
 * content_analyzer schema. Failures are logged but never throw —
 * the local filesystem remains the source of truth during Phase 1.
 *
 * Usage:
 *   import { syncProjectToNeon, syncHistoryToNeon } from "./neon-sync";
 *   // call after every successful local write
 *   void syncProjectToNeon(project).catch(console.warn);
 */

import type { Project } from "./types";

// ── Lazy DB connection ──────────────────────────────────────────────────────
// We use a module-level singleton so we don't open a new connection on every
// write. The connection is only established when DATABASE_URL is set.

let _sql: ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) | null = null;
let _initAttempted = false;

async function getSql() {
  if (_initAttempted) return _sql;
  _initAttempted = true;

  const url = process.env.DATABASE_URL;
  if (!url) {
    // DATABASE_URL not configured — silently skip sync
    return null;
  }

  try {
    // Try @neondatabase/serverless first (edge-compatible)
    const mod = await import("@neondatabase/serverless" as string);
    _sql = mod.neon(url) as typeof _sql;
    return _sql;
  } catch {
    // Fall back to pg (Node.js only)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pg = require("pg") as typeof import("pg");
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      _sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
        let text = "";
        const params: unknown[] = [];
        strings.forEach((s, i) => {
          text += s;
          if (i < values.length) {
            params.push(values[i]);
            text += `$${params.length}`;
          }
        });
        const res = await client.query(text, params);
        return res.rows;
      };
      return _sql;
    } catch {
      console.warn("[neon-sync] No DB driver available — sync disabled");
      return null;
    }
  }
}

// ── Project sync ────────────────────────────────────────────────────────────

/**
 * Mirror a Project to Neon. Also upserts all scenes from the storyboard.
 * Fire-and-forget: call with `void syncProjectToNeon(p)` after local write.
 */
export async function syncProjectToNeon(project: Project): Promise<void> {
  const sql = await getSql();
  if (!sql) return;

  try {
    // Upsert project row
    await sql`
      INSERT INTO content_analyzer.projects
        (project_id, schema_version, title, topic, locale, stage,
         stage_status, stage_history, brief, artifacts,
         template_source, created_at, updated_at)
      VALUES (
        ${project.projectId},
        ${project.schemaVersion},
        ${project.title},
        ${project.topic},
        ${project.locale},
        ${project.stage},
        ${JSON.stringify(project.stageStatus)},
        ${JSON.stringify(project.stageHistory)},
        ${project.brief ? JSON.stringify(project.brief) : null},
        ${JSON.stringify(project.artifacts)},
        ${JSON.stringify(project.templateSource)},
        ${project.createdAt},
        ${project.updatedAt}
      )
      ON CONFLICT (project_id) DO UPDATE SET
        stage         = EXCLUDED.stage,
        stage_status  = EXCLUDED.stage_status,
        stage_history = EXCLUDED.stage_history,
        brief         = EXCLUDED.brief,
        artifacts     = EXCLUDED.artifacts,
        updated_at    = EXCLUDED.updated_at
    `;

    // Upsert scenes (only when storyboard exists)
    const scenes = project.storyboard?.scenes ?? [];
    for (const s of scenes) {
      await sql`
        INSERT INTO content_analyzer.scenes
          (scene_id, project_id, scene_index, title, narration,
           duration_sec, voice, qa_note, audio_path, updated_at)
        VALUES (
          ${s.sceneId},
          ${project.projectId},
          ${s.index},
          ${s.title},
          ${s.narration},
          ${s.durationSec},
          ${s.voice},
          ${s.qaNote ?? ""},
          ${s.audioPath ?? null},
          ${s.updatedAt}
        )
        ON CONFLICT (scene_id, project_id) DO UPDATE SET
          title        = EXCLUDED.title,
          narration    = EXCLUDED.narration,
          duration_sec = EXCLUDED.duration_sec,
          voice        = EXCLUDED.voice,
          qa_note      = EXCLUDED.qa_note,
          audio_path   = EXCLUDED.audio_path,
          updated_at   = EXCLUDED.updated_at
      `;
    }
  } catch (err) {
    // Never throw — local FS is source of truth
    console.warn("[neon-sync] project sync failed:", err instanceof Error ? err.message : err);
  }
}

// ── History sync ────────────────────────────────────────────────────────────

interface HistoryEntry {
  id: string;
  url: string;
  platform: string;
  analyzedAt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
}

/**
 * Mirror an analysis history entry to Neon.
 * Fire-and-forget: call with `void syncHistoryToNeon(entry)`.
 */
export async function syncHistoryToNeon(entry: HistoryEntry): Promise<void> {
  const sql = await getSql();
  if (!sql) return;

  try {
    const r = entry.result;
    const meta = (r.metadata as Record<string, unknown>) ?? {};
    const keywords = Array.isArray(r.keywords) ? (r.keywords as string[]) : [];

    await sql`
      INSERT INTO content_analyzer.analysis_history
        (history_id, url, platform, analyzed_at, title, channel,
         content_style, keywords, result)
      VALUES (
        ${entry.id},
        ${entry.url},
        ${entry.platform},
        ${entry.analyzedAt},
        ${(meta.title as string) ?? null},
        ${(meta.channel as string) ?? null},
        ${(r.content_style as string) ?? null},
        ${keywords},
        ${JSON.stringify(r)}
      )
      ON CONFLICT (history_id) DO UPDATE SET
        result        = EXCLUDED.result,
        title         = EXCLUDED.title,
        channel       = EXCLUDED.channel,
        content_style = EXCLUDED.content_style,
        keywords      = EXCLUDED.keywords
    `;
  } catch (err) {
    console.warn("[neon-sync] history sync failed:", err instanceof Error ? err.message : err);
  }
}

// ── HTML content sync ───────────────────────────────────────────────────────

/**
 * Sync a scene's sub-composition HTML to Neon.
 * Called after writeSceneCompositionHtml succeeds.
 *
 * @param projectId  e.g. "proj_1778428922474_48e007"
 * @param hexTail    first 6 hex chars of the sceneId (from filename)
 * @param html       full HTML string of the sub-composition
 */
export async function syncSceneHtmlToNeon(
  projectId: string,
  hexTail: string,
  html: string,
): Promise<void> {
  const sql = await getSql();
  if (!sql) return;

  try {
    // sceneId format: "sc_xxxxxxxx" — hexTail is the first 6 chars after "sc_"
    await sql`
      UPDATE content_analyzer.scenes
      SET html_content = ${html},
          updated_at   = NOW()
      WHERE project_id = ${projectId}
        AND scene_id LIKE ${'sc_' + hexTail + '%'}
    `;
  } catch (err) {
    console.warn("[neon-sync] scene HTML sync failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Sync the assembled index.html to Neon.
 * Called after writeCompositionHtml succeeds.
 *
 * @param projectId  e.g. "proj_1778428922474_48e007"
 * @param html       full HTML string of index.html
 */
export async function syncIndexHtmlToNeon(
  projectId: string,
  html: string,
): Promise<void> {
  const sql = await getSql();
  if (!sql) return;

  try {
    await sql`
      UPDATE content_analyzer.projects
      SET index_html_content = ${html},
          updated_at         = NOW()
      WHERE project_id = ${projectId}
    `;
  } catch (err) {
    console.warn("[neon-sync] index HTML sync failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Store a scene's MP3 audio as base64 in Neon.
 * Used on Vercel where local filesystem is not persistent.
 *
 * @param projectId   e.g. "proj_1778428922474_48e007"
 * @param sceneIndex  1-based scene index
 * @param buf         raw MP3 bytes
 */
export async function syncAudioToNeon(
  projectId: string,
  sceneIndex: number,
  buf: Buffer,
): Promise<void> {
  const sql = await getSql();
  if (!sql) return;

  try {
    const base64 = buf.toString("base64");
    await sql`
      UPDATE content_analyzer.scenes
      SET audio_data  = ${base64},
          audio_path  = ${"assets/scene-" + sceneIndex + ".mp3"},
          updated_at  = NOW()
      WHERE project_id  = ${projectId}
        AND scene_index = ${sceneIndex}
    `;
  } catch (err) {
    console.warn("[neon-sync] audio sync failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Read index.html from Neon.
 * Returns null when not found.
 */
export async function readIndexHtmlFromNeon(
  projectId: string,
): Promise<string | null> {
  const sql = await getSql();
  if (!sql) return null;

  try {
    const rows = await sql`
      SELECT index_html_content
      FROM content_analyzer.projects
      WHERE project_id = ${projectId}
    ` as Array<{ index_html_content: string | null }>;
    return rows[0]?.index_html_content ?? null;
  } catch (err) {
    console.warn("[neon-sync] readIndexHtml failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Write index.html to Neon (used on Vercel where FS is not persistent).
 */
export async function writeIndexHtmlToNeon(
  projectId: string,
  html: string,
): Promise<void> {
  const sql = await getSql();
  if (!sql) return;

  try {
    await sql`
      UPDATE content_analyzer.projects
      SET index_html_content = ${html},
          updated_at         = NOW()
      WHERE project_id = ${projectId}
    `;
  } catch (err) {
    console.warn("[neon-sync] writeIndexHtml failed:", err instanceof Error ? err.message : err);
    throw err; // re-throw on Vercel — this is the primary storage
  }
}
