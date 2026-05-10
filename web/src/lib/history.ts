/**
 * History module — Phase 2.
 *
 * Reads: Neon content_analyzer.analysis_history (primary)
 *        → local data/history/*.json (fallback when Neon unavailable)
 *
 * Writes: local data/history/*.json (always, for local worker)
 *         + Neon via neon-sync (dual-write, fire-and-forget)
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AnalysisResult } from "./types";
import { sql, sqlOne, isNeonConfigured } from "./db";

// Storage directory for history JSON files (local fallback)
const DATA_DIR = path.join(process.cwd(), "data", "history");

/** Shape of a persisted history entry */
export interface HistoryEntry {
  id: string;
  url: string;
  platform: "xiaohongshu" | "youtube";
  analyzedAt: string; // ISO 8601
  result: AnalysisResult;
}

/** Filters for listing history entries */
export interface HistoryFilter {
  platform?: string;
  startDate?: string; // ISO 8601
  endDate?: string; // ISO 8601
}

// ── Local FS helpers (write path + fallback) ────────────────────────────────

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function detectPlatform(url: string): "xiaohongshu" | "youtube" {
  const lower = url.toLowerCase();
  if (lower.includes("xiaohongshu") || lower.includes("xhslink")) {
    return "xiaohongshu";
  }
  return "youtube";
}

// ── Neon row → HistoryEntry ─────────────────────────────────────────────────

interface NeonHistoryRow {
  history_id: string;
  url: string;
  platform: string;
  analyzed_at: string;
  result: AnalysisResult;
}

function rowToEntry(row: NeonHistoryRow): HistoryEntry {
  return {
    id: row.history_id,
    url: row.url,
    platform: row.platform as "xiaohongshu" | "youtube",
    analyzedAt: typeof row.analyzed_at === "string"
      ? row.analyzed_at
      : new Date(row.analyzed_at).toISOString(),
    result: row.result,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Save a new history entry.
 * Always writes to local FS; also mirrors to Neon (fire-and-forget).
 */
export async function saveHistory(
  url: string,
  result: AnalysisResult
): Promise<HistoryEntry> {
  await ensureDir();

  const id = `h_${Date.now()}`;
  const entry: HistoryEntry = {
    id,
    url,
    platform: detectPlatform(url),
    analyzedAt: new Date().toISOString(),
    result,
  };

  const filePath = path.join(DATA_DIR, `${id}.json`);
  await fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf-8");

  // Phase 1/2 dual-write: mirror to Neon (fire-and-forget, never throws)
  import("@/lib/workbench/neon-sync").then(({ syncHistoryToNeon }) => {
    void syncHistoryToNeon(entry);
  }).catch(() => {/* ignore */});

  return entry;
}

/**
 * Get a single history entry by ID.
 * Reads from Neon when available, falls back to local FS.
 */
export async function getHistoryById(
  id: string
): Promise<HistoryEntry | null> {
  // Neon read
  if (isNeonConfigured()) {
    try {
      const row = await sqlOne<NeonHistoryRow>`
        SELECT history_id, url, platform,
               analyzed_at::text AS analyzed_at,
               result
        FROM content_analyzer.analysis_history
        WHERE history_id = ${id}
      `;
      if (row) return rowToEntry(row);
      return null;
    } catch (err) {
      console.warn("[history] Neon read failed, falling back to FS:", err instanceof Error ? err.message : err);
    }
  }

  // Local FS fallback
  await ensureDir();
  const filePath = path.join(DATA_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as HistoryEntry;
  } catch {
    return null;
  }
}

/** Alias for getHistoryById for convenience. */
export const getHistory = getHistoryById;

/**
 * Delete a history entry by ID.
 * Deletes from both Neon and local FS.
 */
export async function deleteHistory(id: string): Promise<boolean> {
  let deleted = false;

  // Neon delete
  if (isNeonConfigured()) {
    try {
      const rows = await sql`
        DELETE FROM content_analyzer.analysis_history
        WHERE history_id = ${id}
        RETURNING history_id
      `;
      if (rows.length > 0) deleted = true;
    } catch (err) {
      console.warn("[history] Neon delete failed:", err instanceof Error ? err.message : err);
    }
  }

  // Local FS delete (best-effort)
  await ensureDir();
  const filePath = path.join(DATA_DIR, `${id}.json`);
  try {
    await fs.unlink(filePath);
    deleted = true;
  } catch {
    // File may not exist locally if it was only in Neon
  }

  return deleted;
}

/**
 * List all history entries with optional filtering.
 * Reads from Neon when available, falls back to local FS.
 * Results sorted by analyzedAt descending (most recent first).
 */
export async function listHistory(
  filter?: HistoryFilter
): Promise<HistoryEntry[]> {
  // Neon read
  if (isNeonConfigured()) {
    try {
      // Build WHERE clauses dynamically
      const conditions: string[] = [];
      const params: (string | null)[] = [];

      if (filter?.platform) {
        params.push(filter.platform);
        conditions.push(`platform = $${params.length}`);
      }
      if (filter?.startDate) {
        params.push(filter.startDate);
        conditions.push(`analyzed_at >= $${params.length}::timestamptz`);
      }
      if (filter?.endDate) {
        params.push(filter.endDate);
        conditions.push(`analyzed_at <= $${params.length}::timestamptz`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const queryText = `
        SELECT history_id, url, platform,
               analyzed_at::text AS analyzed_at,
               result
        FROM content_analyzer.analysis_history
        ${where}
        ORDER BY analyzed_at DESC
      `;

      // Use raw client for dynamic query
      const { Client } = await import("pg");
      const client = new Client({ connectionString: process.env.DATABASE_URL! });
      await client.connect();
      try {
        const result = await client.query<NeonHistoryRow>(queryText, params);
        return result.rows.map(rowToEntry);
      } finally {
        await client.end();
      }
    } catch (err) {
      console.warn("[history] Neon list failed, falling back to FS:", err instanceof Error ? err.message : err);
    }
  }

  // Local FS fallback
  await ensureDir();
  let files: string[];
  try {
    files = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const entries: HistoryEntry[] = [];
  for (const file of jsonFiles) {
    try {
      const content = await fs.readFile(path.join(DATA_DIR, file), "utf-8");
      entries.push(JSON.parse(content) as HistoryEntry);
    } catch {
      continue;
    }
  }

  let filtered = entries;
  if (filter?.platform) {
    filtered = filtered.filter((e) => e.platform === filter.platform);
  }
  if (filter?.startDate) {
    const start = new Date(filter.startDate).getTime();
    filtered = filtered.filter((e) => new Date(e.analyzedAt).getTime() >= start);
  }
  if (filter?.endDate) {
    const end = new Date(filter.endDate).getTime();
    filtered = filtered.filter((e) => new Date(e.analyzedAt).getTime() <= end);
  }

  filtered.sort((a, b) =>
    new Date(b.analyzedAt).getTime() - new Date(a.analyzedAt).getTime()
  );
  return filtered;
}
