#!/usr/bin/env node
/**
 * Generate a Brief for a project using kiro-cli, then write it to Neon.
 * Usage: node scripts/gen-brief.mjs <projectId> <topic>
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const [, , projectId, ...topicParts] = process.argv;
const topic = topicParts.join(" ");
if (!projectId || !topic) {
  console.error("usage: gen-brief.mjs <projectId> <topic>");
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

const prompt = `请为选题「${topic}」生成一份内容卡 Brief，严格按以下 JSON 格式输出，不要有任何额外文字：{"title":"视频标题（20字以内）","audience":"目标观众（1-2句话）","tone":"语气风格（1句话）","corePoints":["核心观点1","核心观点2","核心观点3","核心观点4","核心观点5"],"suggestedStyle":"视觉风格建议（1-2句话）","targetDurationSec":120}`;

console.log(`Generating Brief for ${projectId} (topic: ${topic})...`);

let briefJson;
try {
  const output = execSync(
    `${KIRO_CLI} chat --model ${MODEL} --no-interactive ${JSON.stringify(prompt)}`,
    { encoding: "utf8", timeout: 120000 },
  );
  // Strip ANSI escape codes, then strip "> " prefixes, then extract JSON
  const stripped = output
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/^>\s*/gm, "")
    .trim();
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in kiro-cli output:\n" + stripped.slice(0, 500));
  briefJson = JSON.parse(jsonMatch[0]);
} catch (err) {
  console.error("kiro-cli failed:", err.message);
  process.exit(1);
}

console.log("Generated Brief:");
console.log(JSON.stringify(briefJson, null, 2));

// Write to Neon
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const now = new Date().toISOString();
await client.query(
  `UPDATE content_analyzer.projects
   SET brief = $1,
       stage_status = jsonb_set(
         jsonb_set(
           jsonb_set(stage_status, '{brief,status}', '"succeeded"'),
           '{brief,finishedAt}', to_jsonb($2::text)
         ),
         '{brief,attempts}',
         to_jsonb(COALESCE((stage_status->'brief'->>'attempts')::int, 0) + 1)
       ),
       updated_at = NOW()
   WHERE project_id = $3`,
  [JSON.stringify(briefJson), now, projectId],
);

await client.end();
console.log(`\n✓ Brief written to Neon for ${projectId}`);
console.log("  Refresh Vercel to see the new Brief.");
