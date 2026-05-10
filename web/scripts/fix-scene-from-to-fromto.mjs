#!/usr/bin/env node
/**
 * Auto-fix HyperFrames sub-composition rule:
 *   Convert `tl.from(target, vars, time)` to
 *           `tl.fromTo(target, vars, <computed-end-state>, time)`
 *
 * The "end state" for a fade-in animation is the element's CSS position
 * (opacity:1, no offset, no scale). We infer it by looking at the properties
 * the caller is tweening FROM, and flipping them to their natural rest values:
 *   opacity:0     -> opacity:1
 *   x:<n>         -> x:0
 *   y:<n>         -> y:0
 *   scale:<n>     -> scale:1
 *   rotation:<n>  -> rotation:0
 *   scaleX/scaleY -> 1
 *   strokeDashoffset -> 0
 *
 * Properties we don't recognize (e.g. attr:, transformOrigin:, ease:, duration:)
 * stay on the from side (duration/ease) or get dropped from the to side.
 *
 * Usage: node scripts/fix-scene-from-to-fromto.mjs <file.html> [...]
 */

import fs from "node:fs";

// Map of "from" property → natural rest value
const REST_MAP = {
  opacity: 1,
  x: 0,
  y: 0,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  strokeDashoffset: 0,
};

// Transient/config properties that belong ONLY on the from side
const CONFIG_ONLY = new Set([
  "duration",
  "ease",
  "stagger",
  "yoyo",
  "repeat",
  "repeatDelay",
  "delay",
  "onUpdate",
  "onStart",
  "onComplete",
  "attr",
  "transformOrigin",
  "svgOrigin",
]);

// Parse a single { ... } vars object (assumes balanced, no nested template strings)
function splitProps(body) {
  // Handle nested { } for things like attr: { x2: 0 }
  const props = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      if (current.trim()) props.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) props.push(current.trim());
  return props;
}

function parseVarsObject(body) {
  const props = splitProps(body);
  const out = [];
  for (const p of props) {
    const m = p.match(/^([a-zA-Z_$][\w$]*)\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    out.push({ key: m[1], value: m[2].trim() });
  }
  return out;
}

function buildToVars(fromProps) {
  const toProps = [];
  // Keep duration/ease/stagger/etc. on from side too — they stay
  // already. Here we build the TO vars: rest values for animated props +
  // duration/ease to control the tween.
  for (const { key, value } of fromProps) {
    if (CONFIG_ONLY.has(key)) {
      toProps.push({ key, value });
      continue;
    }
    if (key in REST_MAP) {
      toProps.push({ key, value: String(REST_MAP[key]) });
    }
    // Unknown animated props are dropped silently — author can add manually.
  }
  return toProps;
}

function renderVars(props) {
  return "{ " + props.map((p) => `${p.key}: ${p.value}`).join(", ") + " }";
}

// Regex that matches `tl.from(X, {Y}, Z)` taking care to balance braces in Y.
// Because JS regex can't balance, we do a manual scan.
function findAndReplaceTlFrom(source) {
  let result = "";
  let i = 0;
  let replaced = 0;
  while (i < source.length) {
    // Look for `tl.from(` but NOT `tl.fromTo(`
    const marker = source.indexOf("tl.from(", i);
    if (marker === -1) {
      result += source.slice(i);
      break;
    }
    // Skip tl.fromTo(
    if (source.slice(marker, marker + 10) === "tl.fromTo(") {
      result += source.slice(i, marker + 10);
      i = marker + 10;
      continue;
    }
    result += source.slice(i, marker);
    // Start scanning from after `tl.from(`
    let p = marker + "tl.from(".length;
    // First arg: target (string or expression). We want to find the comma
    // BEFORE the `{` that opens the vars object, respecting balanced parens.
    // Simpler approach: find the first `,` followed by `{` at depth 0.
    let depth = 0;
    let commaBeforeVars = -1;
    let inStr = null;
    while (p < source.length) {
      const ch = source[p];
      if (inStr) {
        if (ch === inStr && source[p - 1] !== "\\") inStr = null;
      } else if (ch === "'" || ch === '"' || ch === "`") {
        inStr = ch;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
      } else if (ch === "," && depth === 0) {
        // Peek ahead past whitespace for `{`
        let q = p + 1;
        while (q < source.length && /\s/.test(source[q])) q++;
        if (source[q] === "{") {
          commaBeforeVars = p;
          break;
        }
      }
      p++;
    }
    if (commaBeforeVars === -1) {
      // Couldn't parse — leave alone
      result += source.slice(marker, marker + 8);
      i = marker + 8;
      continue;
    }
    const target = source.slice(marker + "tl.from(".length, commaBeforeVars);

    // Now scan the vars object { ... } with balanced braces
    let q = commaBeforeVars + 1;
    while (q < source.length && /\s/.test(source[q])) q++;
    if (source[q] !== "{") {
      result += source.slice(marker, marker + 8);
      i = marker + 8;
      continue;
    }
    let braceDepth = 1;
    let r = q + 1;
    let inStr2 = null;
    while (r < source.length && braceDepth > 0) {
      const ch = source[r];
      if (inStr2) {
        if (ch === inStr2 && source[r - 1] !== "\\") inStr2 = null;
      } else if (ch === "'" || ch === '"' || ch === "`") {
        inStr2 = ch;
      } else if (ch === "{") {
        braceDepth++;
      } else if (ch === "}") {
        braceDepth--;
      }
      r++;
    }
    const varsBody = source.slice(q + 1, r - 1);

    // After vars, expect `, <time>)`
    let s = r;
    while (s < source.length && /\s/.test(source[s])) s++;
    if (source[s] !== ",") {
      // Maybe `tl.from(target, vars)` with no position — still valid but
      // we need a position arg for fromTo. Rare — skip.
      result += source.slice(marker, marker + 8);
      i = marker + 8;
      continue;
    }
    // Find the closing paren at depth 0
    let u = s + 1;
    let parenDepth = 0;
    let inStr3 = null;
    while (u < source.length) {
      const ch = source[u];
      if (inStr3) {
        if (ch === inStr3 && source[u - 1] !== "\\") inStr3 = null;
      } else if (ch === "'" || ch === '"' || ch === "`") {
        inStr3 = ch;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        parenDepth++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        if (parenDepth === 0 && ch === ")") break;
        parenDepth--;
      }
      u++;
    }
    const time = source.slice(s + 1, u).trim();

    // Build fromTo call
    const fromProps = parseVarsObject(varsBody);
    const toProps = buildToVars(fromProps);
    const rewrite = `tl.fromTo(${target}, ${renderVars(fromProps)}, ${renderVars(toProps)}, ${time})`;

    result += rewrite;
    i = u + 1;
    replaced++;
  }
  return { text: result, replaced };
}

// ---------------------------------------------------------------------------

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: fix-scene-from-to-fromto.mjs <file.html> [...]");
  process.exit(1);
}

let totalReplaced = 0;
for (const file of files) {
  const original = fs.readFileSync(file, "utf8");
  const { text, replaced } = findAndReplaceTlFrom(original);
  if (replaced === 0) {
    console.log(`  — ${file} (no tl.from to convert)`);
    continue;
  }
  fs.writeFileSync(file, text, "utf8");
  console.log(`  ✓ ${file}: ${replaced} tl.from → tl.fromTo`);
  totalReplaced += replaced;
}
console.log(`\nTotal: ${totalReplaced} replacements`);
