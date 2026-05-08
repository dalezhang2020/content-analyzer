import { promises as fs } from "node:fs";
import path from "node:path";
import type { AnalysisResult } from "./types";

// Storage directory for history JSON files
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

/**
 * Ensure the data directory exists (mkdir -p equivalent).
 */
async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/**
 * Detect platform from a URL.
 * URLs containing "xiaohongshu" or "xhslink" → "xiaohongshu", else "youtube".
 */
function detectPlatform(url: string): "xiaohongshu" | "youtube" {
  const lower = url.toLowerCase();
  if (lower.includes("xiaohongshu") || lower.includes("xhslink")) {
    return "xiaohongshu";
  }
  return "youtube";
}

/**
 * Save a new history entry. Auto-generates ID and timestamp.
 * Returns the saved entry.
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

  return entry;
}

/**
 * Get a single history entry by ID.
 * Returns null if not found.
 */
export async function getHistoryById(
  id: string
): Promise<HistoryEntry | null> {
  await ensureDir();

  const filePath = path.join(DATA_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as HistoryEntry;
  } catch {
    return null;
  }
}

/**
 * Alias for getHistoryById for convenience.
 */
export const getHistory = getHistoryById;

/**
 * Delete a history entry by ID.
 * Returns true if deleted, false if not found.
 */
export async function deleteHistory(id: string): Promise<boolean> {
  await ensureDir();

  const filePath = path.join(DATA_DIR, `${id}.json`);
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all history entries with optional filtering.
 * Results are sorted by analyzedAt descending (most recent first).
 */
export async function listHistory(
  filter?: HistoryFilter
): Promise<HistoryEntry[]> {
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
      const entry = JSON.parse(content) as HistoryEntry;
      entries.push(entry);
    } catch {
      // Skip malformed files
      continue;
    }
  }

  // Apply filters
  let filtered = entries;

  if (filter?.platform) {
    filtered = filtered.filter((e) => e.platform === filter.platform);
  }

  if (filter?.startDate) {
    const start = new Date(filter.startDate).getTime();
    filtered = filtered.filter(
      (e) => new Date(e.analyzedAt).getTime() >= start
    );
  }

  if (filter?.endDate) {
    const end = new Date(filter.endDate).getTime();
    filtered = filtered.filter((e) => new Date(e.analyzedAt).getTime() <= end);
  }

  // Sort by analyzedAt descending (most recent first)
  filtered.sort(
    (a, b) =>
      new Date(b.analyzedAt).getTime() - new Date(a.analyzedAt).getTime()
  );

  return filtered;
}
