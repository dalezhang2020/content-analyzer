#!/usr/bin/env node
/**
 * Clean stale MP4s under `public/videos/`.
 *
 * Rules:
 *   - `project-{projectId}.mp4` / `.prev.mp4` / `.poster.jpg` — kept when
 *     the matching project JSON still exists under `data/projects/`.
 *   - `video-{timestamp}.mp4` — from the old one-shot `/api/video` route;
 *     always removed (that flow is superseded by the workbench).
 *   - Anything else is listed with a warning.
 *
 * Usage:
 *   node scripts/clean-videos.mjs           # dry run
 *   node scripts/clean-videos.mjs --apply   # actually delete
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";

const apply = process.argv.includes("--apply");
const cwd = process.cwd();
const videosDir = resolve(cwd, "public/videos");
const projectsDir = resolve(cwd, "data/projects");

if (!existsSync(videosDir)) {
  console.log(`[clean-videos] ${videosDir} not found — nothing to do.`);
  process.exit(0);
}

const projectIds = new Set(
  existsSync(projectsDir)
    ? readdirSync(projectsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
    : [],
);

const files = readdirSync(videosDir);
let kept = 0;
let removed = 0;
let bytesFreed = 0;
const unknown = [];

for (const name of files) {
  const abs = join(videosDir, name);
  const size = statSync(abs).size;

  // project-{id}.mp4 / .prev.mp4 / .poster.jpg
  const projectMatch = name.match(
    /^project-(proj_\d+_[a-z0-9]{6})\.(mp4|prev\.mp4|poster\.jpg)$/,
  );
  if (projectMatch) {
    const [, id] = projectMatch;
    if (projectIds.has(id)) {
      kept++;
      continue;
    }
    console.log(`[remove] ${name} (${formatSize(size)}) — orphaned project ${id}`);
    if (apply) unlinkSync(abs);
    removed++;
    bytesFreed += size;
    continue;
  }

  // Legacy video-{timestamp}.mp4 from the old /api/video route.
  if (/^video-\d+\.mp4$/.test(name)) {
    console.log(`[remove] ${name} (${formatSize(size)}) — legacy one-shot`);
    if (apply) unlinkSync(abs);
    removed++;
    bytesFreed += size;
    continue;
  }

  // Legacy plan-*.mp4 — already removed in the /plans cleanup, but
  // double-check.
  if (/^plan-/.test(name)) {
    console.log(`[remove] ${name} (${formatSize(size)}) — legacy /plans`);
    if (apply) unlinkSync(abs);
    removed++;
    bytesFreed += size;
    continue;
  }

  unknown.push({ name, size });
}

if (unknown.length > 0) {
  console.log("\n[warn] Unrecognised files (kept as-is):");
  for (const { name, size } of unknown) {
    console.log(`  - ${name} (${formatSize(size)})`);
  }
}

console.log(
  `\n[summary] kept=${kept} ${apply ? "removed" : "would-remove"}=${removed} bytesFreed=${formatSize(bytesFreed)}`,
);
if (!apply) {
  console.log("[tip] rerun with --apply to actually delete.");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
