#!/usr/bin/env node
/**
 * Download all scene MP3s from Vercel Blob for a given project,
 * writing them into workbench-data/projects/<id>/composition/assets/.
 * Used by the workbench-render Kiro skill.
 *
 * Usage: node scripts/download-audio-for-render.mjs <projectId>
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const projectId = process.argv[2];
if (!projectId) {
  console.error("usage: node scripts/download-audio-for-render.mjs <projectId>");
  process.exit(1);
}

const DIR = `/Users/dizhang/self-project/content-analyzer/workbench-data/projects/${projectId}/composition/assets`;

// Load env from .env.local
const envText = fs.readFileSync(
  "/Users/dizhang/self-project/content-analyzer/web/.env.local",
  "utf8",
);
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

if (!fs.existsSync(DIR)) {
  fs.mkdirSync(DIR, { recursive: true });
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  "SELECT scene_index, audio_blob_url, audio_path FROM content_analyzer.scenes WHERE project_id = $1 ORDER BY scene_index",
  [projectId],
);

if (rows.length === 0) {
  console.error(`No scenes found for project ${projectId}`);
  await client.end();
  process.exit(1);
}

// Clean up stale MP3s whose scene_index is not in the current storyboard
const validIndexes = new Set(rows.map((r) => r.scene_index));
const existing = fs.existsSync(DIR) ? fs.readdirSync(DIR) : [];
for (const f of existing) {
  const m = f.match(/^scene-(\d+)\.mp3$/);
  if (m && !validIndexes.has(Number.parseInt(m[1], 10))) {
    fs.unlinkSync(path.join(DIR, f));
    console.log(`  ✗ removed stale ${f}`);
  }
}

let ok = 0;
for (const s of rows) {
  const url =
    s.audio_blob_url ||
    (s.audio_path && s.audio_path.startsWith("http") ? s.audio_path : null);
  if (!url) {
    console.error(`  ✗ scene ${s.scene_index} has no audio URL`);
    continue;
  }
  const t0 = Date.now();
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  ✗ scene ${s.scene_index}: HTTP ${res.status}`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const dst = path.join(DIR, `scene-${s.scene_index}.mp3`);
  fs.writeFileSync(dst, buf);
  console.log(
    `  ✓ scene-${s.scene_index}.mp3  ${(buf.length / 1024).toFixed(1)}KB  ${Date.now() - t0}ms`,
  );
  ok++;
}

await client.end();
console.log(`\n${ok}/${rows.length} audio files downloaded to ${DIR}`);
