/**
 * Video Creation Workbench — pure HTML `<audio>` injection.
 *
 * Given a composition HTML string, a storyboard, and the set of scenes whose
 * TTS succeeded, produce a new HTML string in which each successful scene is
 * represented by exactly one canonical `<audio class="scene-audio" …>` tag
 * and every non-successful scene has no such tag. Implemented as a plain
 * regex transform (no HTML parser) so it is fast, deterministic, and pure.
 *
 * Canonical tag shape (must match Property 14 in design.md):
 *   <audio class="scene-audio"
 *          data-scene-index="{i}"
 *          data-start="{startSec}"
 *          data-duration="{durationSec}"
 *          src="assets/scene-{i}.mp3"></audio>
 *
 * Behaviour contract:
 *   1. Each index `i ∈ successfulIndexes` (for which `storyboard.scenes`
 *      contains a scene at that index) produces exactly one canonical tag.
 *   2. Any pre-existing tag marked with `data-scene-index="{i}"` is either
 *      replaced in place (when `i ∈ successfulIndexes`) or removed entirely
 *      (when not). Duplicate pre-existing tags for the same index collapse
 *      to a single tag — the first occurrence wins.
 *   3. Canonical tags for successful indexes with no pre-existing tag are
 *      appended before `</body>` (or at the end of the string when no body
 *      close tag is present), in ascending `data-scene-index` order.
 *   4. Indexes in `successfulIndexes` that do not map to any scene in the
 *      storyboard are silently skipped (defensive fallback).
 *
 * _Requirements: 9.10, 9.11, 9.12_
 */

import type { Scene, Storyboard } from "./types";

// ---------------------------------------------------------------------------
// Helpers (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Build a `Map<index, Scene>` keyed by each scene's 1-based `index`. When
 * `storyboard.scenes` contains duplicate indexes (which violates Req 3.3 but
 * is handled defensively here) the last occurrence wins.
 */
export function scenesByIndex(storyboard: Storyboard): Map<number, Scene> {
  const map = new Map<number, Scene>();
  for (const scene of storyboard.scenes) {
    map.set(scene.index, scene);
  }
  return map;
}

/**
 * Compute cumulative start offsets (in seconds) per scene index:
 *   `starts[scene.index] = Σ durationSec[j]` for each scene `j` with a
 *   strictly smaller index. Scenes are sorted by `index` ascending before
 *   accumulation so the result is independent of input order.
 *
 * Values are passed through unrounded — callers can format for display as
 * needed.
 */
export function computeStartOffsets(scenes: Scene[]): Map<number, number> {
  const starts = new Map<number, number>();
  const sorted = [...scenes].sort((a, b) => a.index - b.index);
  let acc = 0;
  for (const scene of sorted) {
    starts.set(scene.index, acc);
    acc += scene.durationSec;
  }
  return starts;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Matches any `<audio … data-scene-index="{digits}" … >` tag, with or
 * without a following `</audio>` closer, case-insensitively. The capture
 * group yields the scene index as a decimal string.
 *
 * Intentionally tolerant: additional attributes in any order before or
 * after `data-scene-index` are allowed, as long as they stay inside the
 * single `<audio …>` element.
 */
const AUDIO_TAG_RE =
  /<audio\s+[^>]*?\bdata-scene-index="(\d+)"[^>]*?>(?:<\/audio>)?/gi;

/** Case-insensitive match for a `</body>` closer (optional whitespace). */
const BODY_CLOSE_RE = /<\/body\s*>/i;

/**
 * Render the canonical `<audio>` tag for a scene. Kept as a single template
 * so tests and future consumers have a single source of truth for the tag
 * shape.
 */
function canonicalTag(
  index: number,
  startSec: number,
  durationSec: number,
): string {
  return (
    `<audio id="scene-${index}-audio" class="scene-audio" ` +
    `data-scene-index="${index}" ` +
    `data-start="${startSec}" ` +
    `data-duration="${durationSec}" ` +
    `src="assets/scene-${index}.mp3"></audio>`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inject canonical `<audio>` tags into `html` for every scene in
 * `successfulIndexes`, removing any tags that correspond to non-successful
 * scenes. Pure function — same inputs always produce the same output.
 *
 * @param html                The composition HTML to transform.
 * @param storyboard          Provides the scenes whose `durationSec` drives
 *                            `data-start` / `data-duration` computation.
 * @param successfulIndexes   1-based scene indexes whose TTS succeeded. May
 *                            be passed as an array or a Set — both are
 *                            treated as the same logical set.
 * @returns                   New HTML string with the invariants described
 *                            at the top of this file.
 *
 * _Requirements: 9.10, 9.11, 9.12_
 */
export function injectAudio(
  html: string,
  storyboard: Storyboard,
  successfulIndexes: number[] | Set<number>,
): string {
  const successful: Set<number> =
    successfulIndexes instanceof Set
      ? new Set(successfulIndexes)
      : new Set(successfulIndexes);

  const byIndex = scenesByIndex(storyboard);
  const starts = computeStartOffsets(storyboard.scenes);

  // Track which indexes we've already emitted so duplicate pre-existing
  // tags for the same index collapse to a single canonical tag.
  const emitted = new Set<number>();

  // Pass 1 — walk every pre-existing <audio data-scene-index="…"> tag and
  // either replace it in place with the canonical form (successful + scene
  // exists) or remove it entirely (everything else).
  const afterReplace = html.replace(AUDIO_TAG_RE, (_match, rawIndex: string) => {
    const index = Number.parseInt(rawIndex, 10);

    // Drop duplicate pre-existing tags for the same index regardless of
    // successful / non-successful state — we only want one tag per scene.
    if (emitted.has(index)) return "";

    if (!successful.has(index)) {
      // Non-successful scene: remove outright.
      return "";
    }

    const scene = byIndex.get(index);
    if (!scene) {
      // Defensive: caller passed an index with no corresponding scene.
      return "";
    }

    emitted.add(index);
    const startSec = starts.get(index) ?? 0;
    return canonicalTag(index, startSec, scene.durationSec);
  });

  // Pass 2 — build canonical tags for successful indexes that had no
  // pre-existing tag. Sorted ascending by index for deterministic output.
  const missing: number[] = [];
  for (const index of successful) {
    if (emitted.has(index)) continue;
    if (!byIndex.has(index)) continue; // silently skip unknown indexes
    missing.push(index);
  }
  missing.sort((a, b) => a - b);

  if (missing.length === 0) return afterReplace;

  const injection = missing
    .map((index) => {
      const scene = byIndex.get(index)!;
      const startSec = starts.get(index) ?? 0;
      return canonicalTag(index, startSec, scene.durationSec);
    })
    .join("");

  // Prefer injection before </body> so the tags end up inside the DOM tree.
  // Fall back to appending when no body close tag is present.
  const bodyMatch = afterReplace.match(BODY_CLOSE_RE);
  if (bodyMatch && typeof bodyMatch.index === "number") {
    const cut = bodyMatch.index;
    return afterReplace.slice(0, cut) + injection + afterReplace.slice(cut);
  }
  return afterReplace + injection;
}
