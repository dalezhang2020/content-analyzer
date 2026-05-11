#!/usr/bin/env node
/**
 * Merge multiple scene sub-compositions into one flat index.html
 * that hyperframes can render reliably.
 *
 * Why: hyperframes 0.5.5's sub-composition seek via data-composition-src
 * does not seem to correctly drive child timelines during headless render
 * (the child timeline stays near t=0). Working around this by inlining
 * each scene's content into the root composition, with each scene's
 * timeline offset-added to a master timeline so playback is one continuous
 * stream.
 *
 * Inputs:
 *   - A scene-order JSON describing [{sceneHtml, durationSec}] in order
 *   - The project's audio assets directory (for <audio> injection)
 *
 * Output:
 *   - index.html at the destination, with:
 *     - All scene root <div>s stacked (each scoped to #scene-XX-XXXXXX)
 *     - All scene <style> tags included as-is
 *     - A single <script> that builds a master timeline and adds each
 *       scene's timeline at its correct offset
 *     - <audio> clips for each scene at the right data-start
 *
 * Usage:
 *   node scripts/merge-scenes-for-render.mjs \
 *        <compositionDir> <destIndexHtml> <audioBaseUrl>
 *
 * <compositionDir> must contain compositions/scene-*.html and assets/
 * Scene order is derived by sorting scene-NN-XXXXXX by NN.
 */

import fs from "node:fs";
import path from "node:path";

const [, , compositionDir, destFile, audioBaseUrlArg] = process.argv;
if (!compositionDir || !destFile) {
  console.error(
    "usage: merge-scenes-for-render.mjs <compositionDir> <destIndexHtml> [<audioBaseUrl>]",
  );
  process.exit(1);
}

const compositionsDir = path.join(compositionDir, "compositions");
const audioDir = path.join(compositionDir, "assets");

// Collect scenes in order
const sceneFiles = fs
  .readdirSync(compositionsDir)
  .filter((f) => /^scene-\d+-[a-f0-9]{6}\.html$/.test(f))
  .sort(); // scene-01-..., scene-02-... sort lexically == numerically for two-digit

const scenes = sceneFiles.map((filename) => {
  const full = path.join(compositionsDir, filename);
  const text = fs.readFileSync(full, "utf8");
  // scene-NN-XXXXXX.html → compositionId = scene-NN-XXXXXX
  const compId = filename.replace(/\.html$/, "");
  // Parse 1-based index from NN
  const idxMatch = filename.match(/^scene-(\d+)-/);
  const sceneIndex = idxMatch ? Number.parseInt(idxMatch[1], 10) : 0;

  // Extract template inner
  const tpl = text.match(/<template[^>]*>([\s\S]*?)<\/template>/);
  if (!tpl) throw new Error(`No <template> in ${filename}`);
  const inner = tpl[1];

  // Extract duration from data-duration (if the scene sets it explicitly)
  // or from the final tl.set({}, {}, N) in the script
  let duration = 0;
  const setMatch = text.match(/tl\.set\(\s*\{\s*\}\s*,\s*\{\s*\}\s*,\s*(\d+(?:\.\d+)?)\s*\)/);
  if (setMatch) duration = Number.parseFloat(setMatch[1]);
  const dataDur = text.match(/data-duration=["'](\d+(?:\.\d+)?)["']/);
  if (!duration && dataDur) duration = Number.parseFloat(dataDur[1]);
  if (!duration) duration = 10; // sane default

  return { filename, compId, sceneIndex, inner, duration };
});

// Compute cumulative offsets
let cumulative = 0;
const offsets = scenes.map((s) => {
  const start = cumulative;
  cumulative += s.duration;
  return start;
});
const totalDuration = cumulative;

// Build combined HTML
//
// Strategy: paste each scene's template-inner directly into <body>.
// Each scene's <script> is rewritten so its timeline is added to the
// master timeline at the correct offset, and the local `tl` variable is
// renamed `tl_N` to avoid collisions when multiple scenes' scripts run.

const sceneBlocks = [];
const timelineRegistrations = [];

for (let i = 0; i < scenes.length; i++) {
  const s = scenes[i];
  const offset = offsets[i];

  // Extract <style>, <script>, and the root <div> from s.inner
  const scriptMatch = s.inner.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error(`No <script> in ${s.filename}`);
  const scriptBody = scriptMatch[1];

  // Rename `const tl` → `const tl_NN`, `tl.` → `tl_NN.`, and skip the
  // window.__timelines registration (we'll re-register after inlining).
  // Also remove `paused: true` so the timeline is ready to be nested
  // under the master (GSAP child timelines must not be paused when added
  // to a parent, or seek doesn't propagate).
  const tag = `s${String(i).padStart(2, "0")}`;
  let rewritten = scriptBody
    // rename local var
    .replace(/\bconst\s+tl\s*=/g, `const tl_${tag} =`)
    .replace(/\blet\s+tl\s*=/g, `let tl_${tag} =`)
    .replace(/\bvar\s+tl\s*=/g, `var tl_${tag} =`)
    .replace(/\btl\./g, `tl_${tag}.`)
    // strip paused: true / paused:true so the child timeline is driven
    // by the master when added. The master itself stays paused.
    .replace(/paused\s*:\s*true\s*,?\s*/g, "")
    // skip the window.__timelines[...] = X line — whether the RHS is
    // `tl` (naked, kept as-is by earlier replacements — broken!) or
    // already-renamed `tl_sNN`. Match the full line and strip it.
    .replace(/window\.__timelines\s*\[[^\]]+\]\s*=\s*[a-zA-Z_$][\w$]*\s*;?/g, "");

  // Also rename `state`/helper const/let variables that might clash across
  // scenes. Use a simple approach — we only wrap the rewritten block in an
  // IIFE to isolate scope.
  const iife = `\n// --- Scene ${i + 1} (${s.compId}) --- offset=${offset}s dur=${s.duration}s\n(function() {\n${rewritten}\n  if (typeof tl_${tag} !== 'undefined') {\n    __master.add(tl_${tag}, ${offset});\n  }\n})();`;
  timelineRegistrations.push(iife);

  // Keep scene content: replace the <script>...</script> inside inner
  // with nothing (we hoist all scripts out).
  const contentWithoutScript = s.inner.replace(/<script>[\s\S]*?<\/script>/g, "");

  sceneBlocks.push(
    `  <!-- ================== ${s.compId} (offset=${offset}s, dur=${s.duration}s) ================== -->\n` +
      contentWithoutScript,
  );
}

// Build <audio> elements pointing at the assets/ URLs (or optionally
// absolute blob URLs, if --audio-base-url is given).
const audioElements = [];
if (fs.existsSync(audioDir)) {
  for (const s of scenes) {
    const audioFile = `scene-${s.sceneIndex}.mp3`;
    const audioPath = path.join(audioDir, audioFile);
    if (!fs.existsSync(audioPath)) continue;
    const offset = offsets[scenes.indexOf(s)];
    const src = audioBaseUrlArg
      ? `${audioBaseUrlArg.replace(/\/$/, "")}/${audioFile}`
      : `assets/${audioFile}`;
    audioElements.push(
      `  <audio id="scene-${s.sceneIndex}-audio" class="scene-audio" data-scene-index="${s.sceneIndex}" data-start="${offset}" data-duration="${s.duration}" src="${src}"></audio>`,
    );
  }
}

const indexHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=1920, height=1080" />
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1920px; height: 1080px; overflow: hidden; background: #000; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="${totalDuration}" data-width="1920" data-height="1080">

${sceneBlocks.join("\n")}

  </div>

${audioElements.join("\n")}

  <script>
    window.__timelines = window.__timelines || {};
    const __master = gsap.timeline({ paused: true });

    // Scene visibility: each scene root is display:none except during
    // its own time window. Using display (not opacity/visibility) so
    // that hidden scenes genuinely don't render and can't interfere
    // with the active scene. GSAP set() at specific times will update
    // display when master.seek() is called.
    //
    // Initial state: all scenes hidden (CSS default via display:none on
    // body > [data-composition-id^="scene-"] won't work because the
    // wrapping is inside #root). We use GSAP set at t=0 for all.
${scenes
  .map((s, i) => {
    const start = offsets[i];
    const end = start + s.duration;
    const sel = `[data-composition-id="${s.compId}"]`;
    return `    __master.set('${sel}', { display: 'none' }, 0);
    __master.set('${sel}', { display: 'block' }, ${start});
    __master.set('${sel}', { display: 'none' }, ${end});`;
  })
  .join("\n")}

${timelineRegistrations.join("\n")}

    // Lock master to the total duration so hyperframes knows exactly how
    // long the video is.
    __master.set({}, {}, ${totalDuration});

    window.__timelines["main"] = __master;
  </script>
</body>
</html>
`;

fs.writeFileSync(destFile, indexHtml);
console.log(`\n✓ wrote ${destFile}`);
console.log(`  ${scenes.length} scenes, total ${totalDuration}s`);
for (let i = 0; i < scenes.length; i++) {
  console.log(
    `    ${scenes[i].filename}  start=${offsets[i]}s  dur=${scenes[i].duration}s`,
  );
}
console.log(`  ${audioElements.length} audio clips`);
