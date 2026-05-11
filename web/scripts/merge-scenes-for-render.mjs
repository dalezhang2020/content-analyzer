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
  // Also inject clip attributes on the scene root div so HyperFrames
  // manages visibility automatically.
  let contentWithoutScript = s.inner.replace(/<script>[\s\S]*?<\/script>/g, "");

  // Inject class="clip" data-start data-duration data-track-index on the
  // scene's root div (the one with data-composition-id).
  contentWithoutScript = contentWithoutScript.replace(
    new RegExp(`(<div[^>]*data-composition-id="${s.compId}"[^>]*)>`),
    `$1 class="clip" data-start="${offset}" data-duration="${s.duration}" data-track-index="1">`,
  );

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
    /* Shutter transition overlays */
    .shutter-top, .shutter-bot {
      position: fixed; left: 0; right: 0; height: 50%;
      background: #030610; z-index: 9999;
      transform: scaleY(0); pointer-events: none;
    }
    .shutter-top { top: 0; transform-origin: top center; }
    .shutter-bot { bottom: 0; transform-origin: bottom center; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="${totalDuration}" data-width="1920" data-height="1080">

${sceneBlocks.join("\n")}

  </div>

  <!-- Shutter transition elements -->
  <div class="shutter-top" id="sh-top"></div>
  <div class="shutter-bot" id="sh-bot"></div>

${audioElements.join("\n")}

  <script>
    window.__timelines = window.__timelines || {};
    const __master = gsap.timeline({ paused: true });

    // Scene visibility is managed by HyperFrames' clip mechanism:
    // each scene root div has class="clip" + data-start + data-duration,
    // so HyperFrames automatically shows/hides them at the right time.

    // Shutter transitions between scenes (close → open):
    // Each transition takes 0.7s total, centered on the scene boundary.
${scenes.length > 1 ? scenes.slice(1).map((s, i) => {
    const boundary = offsets[i + 1]; // time when scene i+1 starts
    const closeStart = boundary - 0.35;
    const openStart = boundary + 0.01;
    return `    // Transition ${i + 1} → ${i + 2} at t=${boundary}s
    __master.fromTo('#sh-top', { scaleY: 0 }, { scaleY: 1, duration: 0.3, ease: 'power3.in' }, ${closeStart.toFixed(2)});
    __master.fromTo('#sh-bot', { scaleY: 0 }, { scaleY: 1, duration: 0.3, ease: 'power3.in' }, ${closeStart.toFixed(2)});
    __master.to('#sh-top', { scaleY: 0, duration: 0.35, ease: 'power3.out' }, ${openStart.toFixed(2)});
    __master.to('#sh-bot', { scaleY: 0, duration: 0.35, ease: 'power3.out' }, ${openStart.toFixed(2)});`;
  }).join("\n") : "    // Single scene — no transitions needed."}

${timelineRegistrations.join("\n")}

    // Lock master to the total duration.
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
