#!/usr/bin/env node
/**
 * Usage: node scripts/inline-scene-to-preview.mjs <sceneHtmlPath> <destIndexHtml>
 *
 * Extracts the contents of a sub-composition <template>...</template>
 * and writes a flat index.html that hosts the scene directly (no
 * data-composition-src). Use this to test whether rendering works
 * without the sub-composition nest.
 */
import fs from "node:fs";

const [, , sceneFile, destFile] = process.argv;
if (!sceneFile || !destFile) {
  console.error("usage: inline-scene-to-preview.mjs <scene.html> <dest.html>");
  process.exit(1);
}

const src = fs.readFileSync(sceneFile, "utf8");
const m = src.match(/<template[^>]*>([\s\S]*?)<\/template>/);
if (!m) {
  console.error("No <template> found in", sceneFile);
  process.exit(1);
}
const inner = m[1];

const out = `<!doctype html>
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
${inner}
</body>
</html>
`;

fs.writeFileSync(destFile, out);
console.log(`wrote ${destFile} (${out.length} bytes)`);
