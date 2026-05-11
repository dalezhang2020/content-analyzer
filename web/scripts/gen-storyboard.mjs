#!/usr/bin/env node
/**
 * Generate a Storyboard for a project using kiro-cli, then write it to Neon.
 * Usage: node scripts/gen-storyboard.mjs <projectId>
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";

const [, , projectId] = process.argv;
if (!projectId) {
  console.error("usage: gen-storyboard.mjs <projectId>");
  process.exit(1);
}

// Load env
const envText = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "../.env.local"),
  "utf8",
);
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const KIRO_CLI = process.env.KIRO_CLI_BIN ?? "/Users/dizhang/.local/bin/kiro-cli";
const MODEL = process.env.KIRO_MODEL ?? "claude-opus-4.7";

// Read project + brief from Neon
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  "SELECT brief, locale FROM content_analyzer.projects WHERE project_id = $1",
  [projectId],
);
if (!rows[0]?.brief) {
  console.error("No brief found for project", projectId);
  await client.end();
  process.exit(1);
}

const brief = rows[0].brief;
const locale = rows[0].locale ?? "zh-CN";
const voice = locale.startsWith("zh") ? "zh-CN-XiaoxiaoNeural" : "en-US-JennyNeural";

console.log(`Generating Storyboard for ${projectId}...`);
console.log(`Brief: ${brief.title}`);

const prompt = `为视频「${brief.title}」生成分镜，目标观众：${brief.audience}，语气：${brief.tone}，核心观点：${brief.corePoints.slice(0, 3).join("；")}，目标时长${brief.targetDurationSec}秒。生成7-9个场景，每场景10-18秒，总时长接近${brief.targetDurationSec}秒。只输出JSON数组，格式：[{"title":"标题","narration":"旁白（60字内）","durationSec":12,"voice":"${voice}"},...]`;

let scenes;
try {
  const output = execSync(
    `${KIRO_CLI} chat --model ${MODEL} --no-interactive ${JSON.stringify(prompt)}`,
    { encoding: "utf8", timeout: 120000 },
  );
  // Strip ANSI escape codes, then strip "> " prefixes, then extract JSON array
  const stripped = output
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")  // remove ANSI codes
    .replace(/^>\s*/gm, "")                    // remove "> " line prefixes
    .trim();
  const jsonMatch = stripped.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) throw new Error("No JSON array found in output:\n" + stripped.slice(0, 500));
  scenes = JSON.parse(jsonMatch[0]);
} catch (err) {
  console.error("kiro-cli failed:", err.message);
  await client.end();
  process.exit(1);
}

console.log(`\nGenerated ${scenes.length} scenes:`);
scenes.forEach((s, i) => {
  console.log(`  ${i + 1}. [${s.durationSec}s] ${s.title}`);
  console.log(`     ${s.narration.slice(0, 60)}...`);
});

const totalDuration = scenes.reduce((sum, s) => sum + s.durationSec, 0);
console.log(`\nTotal duration: ${totalDuration}s`);

// Write scenes to Neon
const now = new Date().toISOString();

// Delete existing scenes
await client.query(
  "DELETE FROM content_analyzer.scenes WHERE project_id = $1",
  [projectId],
);

// Insert new scenes
for (let i = 0; i < scenes.length; i++) {
  const s = scenes[i];
  const sceneId = `sc_${randomBytes(4).toString("hex")}`;
  await client.query(
    `INSERT INTO content_analyzer.scenes
       (scene_id, project_id, scene_index, title, narration, duration_sec, voice, qa_note, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [sceneId, projectId, i + 1, s.title, s.narration, s.durationSec, s.voice, "", now],
  );
}

// Update project stage + storyboard status
await client.query(
  `UPDATE content_analyzer.projects
   SET stage = 'storyboard',
       stage_status = jsonb_set(
         jsonb_set(
           jsonb_set(stage_status, '{storyboard,status}', '"succeeded"'),
           '{storyboard,finishedAt}', to_jsonb($1::text)
         ),
         '{storyboard,attempts}',
         to_jsonb(COALESCE((stage_status->'storyboard'->>'attempts')::int, 0) + 1)
       ),
       updated_at = NOW()
   WHERE project_id = $2`,
  [now, projectId],
);

await client.end();
console.log(`\n✓ Storyboard written to Neon for ${projectId}`);
console.log("  Refresh Vercel to see the new Storyboard.");
