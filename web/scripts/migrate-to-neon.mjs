#!/usr/bin/env node
/**
 * Phase 1 data migration: local JSON files → Neon content_analyzer schema
 *
 * Migrates:
 *   1. web/data/history/*.json → content_analyzer.analysis_history
 *   2. workbench-data/projects/*.json → content_analyzer.projects + scenes
 *
 * Usage:
 *   node scripts/migrate-to-neon.mjs           # dry run (prints counts)
 *   node scripts/migrate-to-neon.mjs --apply   # actually insert
 *
 * Requires DATABASE_URL in .env.local (Neon connection string).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const apply = process.argv.includes("--apply");
const cwd = process.cwd(); // should be content-analyzer/web

// ── Load DATABASE_URL from .env.local ──────────────────────────────────────
function loadEnv() {
  const envPath = join(cwd, ".env.local");
  if (!existsSync(envPath)) {
    console.error("❌  .env.local not found at", envPath);
    process.exit(1);
  }
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌  DATABASE_URL not set in .env.local");
  console.error("   Add: DATABASE_URL=postgresql://...");
  process.exit(1);
}

// ── Lazy-load postgres (neon serverless driver) ────────────────────────────
// We use the standard pg-compatible interface via @neondatabase/serverless
// which is already in node_modules (installed by shadcn/drizzle toolchain).
// If not present, fall back to a raw fetch-based approach.
async function getDb() {
  try {
    const { neon } = await import("@neondatabase/serverless");
    return neon(DATABASE_URL);
  } catch {
    // Fallback: use node-postgres if available
    try {
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: DATABASE_URL });
      await client.connect();
      const sql = async (strings, ...values) => {
        // Tagged template → parameterized query
        let text = "";
        const params = [];
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
      sql._client = client;
      return sql;
    } catch {
      console.error("❌  Neither @neondatabase/serverless nor pg found.");
      console.error("   Run: npm install pg");
      process.exit(1);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .map((f) => join(dir, f));
}

// ── 1. Migrate analysis_history ────────────────────────────────────────────
async function migrateHistory(sql) {
  const historyDir = join(cwd, "data", "history");
  const files = listJsonFiles(historyDir);
  console.log(`\n📂 History: found ${files.length} files in ${historyDir}`);

  let inserted = 0;
  let skipped = 0;

  for (const file of files) {
    const d = readJson(file);
    const r = d.result ?? {};
    const meta = r.metadata ?? {};
    const keywords = Array.isArray(r.keywords) ? r.keywords : [];

    console.log(`  → ${d.id}: ${(meta.title ?? d.url).slice(0, 60)}`);

    if (!apply) {
      skipped++;
      continue;
    }

    try {
      await sql`
        INSERT INTO content_analyzer.analysis_history
          (history_id, url, platform, analyzed_at, title, channel,
           content_style, keywords, result)
        VALUES (
          ${d.id},
          ${d.url},
          ${d.platform},
          ${d.analyzedAt},
          ${meta.title ?? null},
          ${meta.channel ?? null},
          ${r.content_style ?? null},
          ${keywords},
          ${JSON.stringify(r)}
        )
        ON CONFLICT (history_id) DO UPDATE SET
          result = EXCLUDED.result,
          title = EXCLUDED.title,
          channel = EXCLUDED.channel,
          content_style = EXCLUDED.content_style,
          keywords = EXCLUDED.keywords
      `;
      inserted++;
    } catch (err) {
      console.error(`    ❌ Failed: ${err.message}`);
    }
  }

  console.log(`  ✓ History: ${apply ? `${inserted} upserted` : `${files.length} would upsert (dry run)`}`);
  return inserted;
}

// ── 2. Migrate projects + scenes ───────────────────────────────────────────
async function migrateProjects(sql) {
  const projectsDir = resolve(cwd, "..", "workbench-data", "projects");
  const files = listJsonFiles(projectsDir);
  console.log(`\n📂 Projects: found ${files.length} files in ${projectsDir}`);

  let projInserted = 0;
  let sceneInserted = 0;

  for (const file of files) {
    const d = readJson(file);
    const scenes = d.storyboard?.scenes ?? [];

    console.log(`  → ${d.projectId}: "${d.title}" stage=${d.stage} scenes=${scenes.length}`);

    if (!apply) continue;

    try {
      // Upsert project
      await sql`
        INSERT INTO content_analyzer.projects
          (project_id, schema_version, title, topic, locale, stage,
           stage_status, stage_history, brief, artifacts,
           template_source, created_at, updated_at)
        VALUES (
          ${d.projectId},
          ${d.schemaVersion ?? 1},
          ${d.title},
          ${d.topic},
          ${d.locale ?? "zh-CN"},
          ${d.stage},
          ${JSON.stringify(d.stageStatus ?? {})},
          ${JSON.stringify(d.stageHistory ?? [])},
          ${d.brief ? JSON.stringify(d.brief) : null},
          ${JSON.stringify(d.artifacts ?? {})},
          ${JSON.stringify(d.templateSource ?? {})},
          ${d.createdAt},
          ${d.updatedAt}
        )
        ON CONFLICT (project_id) DO UPDATE SET
          stage = EXCLUDED.stage,
          stage_status = EXCLUDED.stage_status,
          stage_history = EXCLUDED.stage_history,
          brief = EXCLUDED.brief,
          artifacts = EXCLUDED.artifacts,
          updated_at = EXCLUDED.updated_at
      `;
      projInserted++;

      // Upsert scenes
      for (const s of scenes) {
        await sql`
          INSERT INTO content_analyzer.scenes
            (scene_id, project_id, scene_index, title, narration,
             duration_sec, voice, qa_note, audio_path, updated_at)
          VALUES (
            ${s.sceneId},
            ${d.projectId},
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
            title = EXCLUDED.title,
            narration = EXCLUDED.narration,
            duration_sec = EXCLUDED.duration_sec,
            voice = EXCLUDED.voice,
            qa_note = EXCLUDED.qa_note,
            audio_path = EXCLUDED.audio_path,
            updated_at = EXCLUDED.updated_at
        `;
        sceneInserted++;
      }
    } catch (err) {
      console.error(`    ❌ Failed: ${err.message}`);
    }
  }

  console.log(`  ✓ Projects: ${apply ? `${projInserted} upserted` : `${files.length} would upsert (dry run)`}`);
  console.log(`  ✓ Scenes:   ${apply ? `${sceneInserted} upserted` : "? (dry run)"}`);
}

// ── 3. Verify ──────────────────────────────────────────────────────────────
async function verify(sql) {
  const [{ count: hCount }] = await sql`SELECT COUNT(*) FROM content_analyzer.analysis_history`;
  const [{ count: pCount }] = await sql`SELECT COUNT(*) FROM content_analyzer.projects`;
  const [{ count: sCount }] = await sql`SELECT COUNT(*) FROM content_analyzer.scenes`;
  console.log(`\n✅ Neon content_analyzer schema:`);
  console.log(`   analysis_history: ${hCount} rows`);
  console.log(`   projects:         ${pCount} rows`);
  console.log(`   scenes:           ${sCount} rows`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Phase 1 migration — ${apply ? "APPLYING" : "DRY RUN"}`);
  console.log(`   DATABASE_URL: ${DATABASE_URL.replace(/:([^@]+)@/, ":***@")}`);

  const sql = await getDb();

  await migrateHistory(sql);
  await migrateProjects(sql);

  if (apply) {
    await verify(sql);
  } else {
    console.log("\n💡 Dry run complete. Run with --apply to insert data.");
  }

  // Close pg client if used
  if (sql._client) await sql._client.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
