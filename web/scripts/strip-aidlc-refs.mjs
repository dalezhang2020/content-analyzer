#!/usr/bin/env node
/**
 * Strip aidlc-generated `_Requirements: …_` references from JSDoc blocks.
 * Removes the entire line when it matches:
 *    ` * _Requirements: ...`      (doc-block line)
 *    ` *                           (doc-block line that only had blank
 *                                    space before the stripped line)
 * Run with --apply to write changes.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const apply = process.argv.includes("--apply");
const root = "src";
let changed = 0;
let filesTouched = 0;

walk(root);

console.log(
  `\n[summary] filesTouched=${filesTouched} linesRemoved=${changed} ${apply ? "(written)" : "(dry run — rerun with --apply)"}`,
);

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) processFile(p);
  }
}

function processFile(p) {
  const src = readFileSync(p, "utf8");
  const lines = src.split("\n");
  const out = [];
  let removed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // `   * _Requirements: 1.2, 3.4_`  (inside JSDoc)
    if (/^\s*\*\s*_Requirements:.*$/.test(line)) {
      removed++;
      // If the previous doc line was a blank ` * `, also drop it to
      // avoid leaving an orphaned blank comment line.
      if (out.length > 0 && /^\s*\*\s*$/.test(out[out.length - 1])) {
        const prev = out[out.length - 1];
        // Keep blank doc-line if it's followed by more real content
        // (checked below via peek).
        let k = i + 1;
        while (k < lines.length && /^\s*\*\s*$/.test(lines[k])) k++;
        if (k >= lines.length || /^\s*\*\//.test(lines[k])) {
          // next is end-of-block, so our previous blank-doc is safe to drop
          out.pop();
        }
        void prev;
      }
      continue;
    }
    out.push(line);
  }

  if (removed > 0) {
    changed += removed;
    filesTouched++;
    if (apply) writeFileSync(p, out.join("\n"), "utf8");
    console.log(`  ${p} (${removed} line${removed === 1 ? "" : "s"})`);
  }
}
