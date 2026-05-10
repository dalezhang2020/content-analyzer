#!/usr/bin/env node
/**
 * One-time backfill: push existing local HTML files to Neon.
 *
 * For each project in workbench-data/projects/:
 *   - composition/index.html → projects.index_html_content
 *   - composition/compositions/scene-NN-xxxxxx.html → scenes.html_content
 *
 * Usage:
 *   node scripts/sync-html-to-neon.mjs           # dry run
 *   node scripts/sync-html-to-neon.mjs --apply   # actually sync
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const apply = process.argv.includes("--apply");
const cwd = process.cwd(); // content-analyzer/web

// Load .env.local
const envPath = join(cwd, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌  DATABASE_URL not set");
  process.exit(1);
}

// Connect
const { default: pg } = await import("pg");
const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

const projectsDir = resolve(cwd, "..", "workbench-data", "projects");
const projectDirs = readdirSync(projectsDir).filter(
  (name) => /^proj_/.test(name) && existsSync(join(projectsDir, name, "composition"))
);

console.log(`\n🚀 HTML sync — ${apply ? "APPLYING" : "DRY RUN"}`);
console.log(`   Found ${projectDirs.length} project(s) with composition dirs\n`);

let indexSynced = 0;
let sceneSynced = 0;

for (const projectId of projectDirs) {
  const compositionDir = join(projectsDir, projectId, "composition");
  console.log(`📁 ${projectId}`);

  // ── index.html ────────────────────────────────────────────────────────────
  const indexPath = join(compositionDir, "index.html");
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, "utf8");
    console.log(`   index.html  ${(html.length / 1024).toFixed(1)}KB`);
    if (apply) {
      await client.query(
        `UPDATE content_analyzer.projects
         SET index_html_content = $1, updated_at = NOW()
         WHERE project_id = $2`,
        [html, projectId]
      );
      indexSynced++;
    }
  } else {
    console.log(`   index.html  (not found)`);
  }

  // ── scene HTMLs ───────────────────────────────────────────────────────────
  const compositionsDir = join(compositionDir, "compositions");
  if (!existsSync(compositionsDir)) {
    console.log(`   compositions/ (not found)`);
    continue;
  }

  const sceneFiles = readdirSync(compositionsDir).filter((f) => f.endsWith(".html"));
  for (const filename of sceneFiles) {
    // filename: scene-05-88ea72.html → hexTail = "88ea72"
    const m = filename.match(/^scene-\d+-([a-z0-9]{6})\.html$/);
    if (!m) continue;
    const hexTail = m[1];

    const html = readFileSync(join(compositionsDir, filename), "utf8");
    console.log(`   ${filename}  ${(html.length / 1024).toFixed(1)}KB  (hexTail=${hexTail})`);

    if (apply) {
      const res = await client.query(
        `UPDATE content_analyzer.scenes
         SET html_content = $1, updated_at = NOW()
         WHERE project_id = $2 AND scene_id LIKE $3`,
        [html, projectId, `sc_${hexTail}%`]
      );
      if (res.rowCount && res.rowCount > 0) {
        sceneSynced++;
      } else {
        console.log(`     ⚠️  No matching scene row for hexTail=${hexTail}`);
      }
    }
  }
}

if (apply) {
  // Verify
  const { rows: [{ count: sceneCount }] } = await client.query(
    `SELECT COUNT(*) FROM content_analyzer.scenes WHERE html_content IS NOT NULL`
  );
  const { rows: [{ count: projCount }] } = await client.query(
    `SELECT COUNT(*) FROM content_analyzer.projects WHERE index_html_content IS NOT NULL`
  );
  console.log(`\n✅ Done:`);
  console.log(`   index.html synced: ${indexSynced}`);
  console.log(`   scene HTML synced: ${sceneSynced}`);
  console.log(`   Neon scenes with html_content: ${sceneCount}`);
  console.log(`   Neon projects with index_html_content: ${projCount}`);
} else {
  console.log(`\n💡 Dry run. Run with --apply to push HTML to Neon.`);
}

await client.end();
