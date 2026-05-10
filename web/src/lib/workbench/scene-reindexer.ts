/**
 * Video Creation Workbench — pure scene-array operations.
 *
 * Scenes inside a Storyboard MUST be numbered 1..N contiguously (1-based).
 * Whenever a scene is inserted, deleted, reordered, or bulk-rewritten, this
 * module produces a fresh array where `index` is re-numbered and any
 * canonical `audioPath` (the `assets/scene-{index}.mp3` form that TTSService
 * emits) is rewritten to stay aligned with the new index. Any caller-provided
 * custom path is left alone.
 *
 * Every export is pure: inputs are never mutated, outputs are new arrays or
 * objects. No I/O, no Date side-effects (except `applySceneEdit`, which
 * accepts an injected `now` for deterministic tests).
 *
 * Properties this module upholds (see design §Correctness Properties):
 *   - Property 9: reindex preserves `[1..N]` under any edit sequence.
 *   - Property 10: `applySceneEdit` clears `audioPath` iff `narration` or
 *     `voice` changed value.
 */

import type { Scene } from "./types";

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Canonical audio-path shape produced by `TTSService`. Any deviation
 * (null, custom string, renamed asset) is left untouched by `remapAudioPath`.
 */
const CANONICAL_AUDIO_PATH = /^assets\/scene-\d+\.mp3$/;

/** Clamp `n` to the inclusive range `[lo, hi]`. Returns `lo` when `hi < lo`. */
function clamp(n: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * If `scene.audioPath` matches the canonical `assets/scene-{N}.mp3` shape,
 * returns a new scene with the path rewritten to reflect `newIndex`.
 * Otherwise (null, or a custom path) the scene is returned unchanged.
 *
 * This helper does NOT touch `scene.index` — the caller is responsible for
 * setting that. See `reindex` for the combined operation.
 */
export function remapAudioPath(scene: Scene, newIndex: number): Scene {
  const current = scene.audioPath;
  if (current === null) return scene;
  if (!CANONICAL_AUDIO_PATH.test(current)) return scene;
  const rewritten = `assets/scene-${newIndex}.mp3`;
  if (rewritten === current) return scene;
  return { ...scene, audioPath: rewritten };
}

/**
 * Returns a new array where each scene's `index` equals `i + 1` (1-based,
 * contiguous) and any canonical `audioPath` is remapped to the new index.
 *
 * Input is never mutated; the returned array is always a new reference.
 */
export function reindex(scenes: Scene[]): Scene[] {
  return scenes.map((scene, i) => {
    const newIndex = i + 1;
    const remapped = remapAudioPath(scene, newIndex);
    if (remapped.index === newIndex) return remapped;
    return { ...remapped, index: newIndex };
  });
}

/**
 * Insert `newScene` at 0-based position `at` (clamped to `[0, scenes.length]`)
 * and return the reindexed array.
 */
export function insertScene(
  scenes: Scene[],
  at: number,
  newScene: Scene,
): Scene[] {
  const pos = clamp(at, 0, scenes.length);
  const next = scenes.slice();
  next.splice(pos, 0, newScene);
  return reindex(next);
}

/**
 * Remove the scene whose `sceneId` matches and return the reindexed array.
 * If no scene matches, returns the original array unchanged (same reference).
 */
export function deleteScene(scenes: Scene[], sceneId: string): Scene[] {
  const idx = scenes.findIndex((s) => s.sceneId === sceneId);
  if (idx === -1) return scenes;
  const next = scenes.slice();
  next.splice(idx, 1);
  return reindex(next);
}

/**
 * Move the scene at position `from` to position `to` (both 0-based,
 * clamped to `[0, scenes.length - 1]`) and return the reindexed array.
 * On an empty array, returns a new empty array.
 */
export function moveScene(
  scenes: Scene[],
  from: number,
  to: number,
): Scene[] {
  if (scenes.length === 0) return [];
  const upper = scenes.length - 1;
  const src = clamp(from, 0, upper);
  const dst = clamp(to, 0, upper);
  const next = scenes.slice();
  if (src !== dst) {
    const [moved] = next.splice(src, 1);
    next.splice(dst, 0, moved);
  }
  return reindex(next);
}

/**
 * Apply an edit patch to a single scene. Fields omitted from the patch (or
 * explicitly set to `undefined`) are left as-is.
 *
 * `audioPath` is cleared (`null`) iff the patch introduces a different
 * `narration` or `voice` than the current scene has — matches Property 10.
 *
 * `updatedAt` is refreshed to `now ?? new Date().toISOString()`.
 */
export function applySceneEdit(
  scene: Scene,
  patch: Partial<
    Pick<Scene, "title" | "narration" | "durationSec" | "voice" | "qaNote">
  >,
  now?: string,
): Scene {
  const narrationChanged =
    patch.narration !== undefined && patch.narration !== scene.narration;
  const voiceChanged =
    patch.voice !== undefined && patch.voice !== scene.voice;
  const invalidateAudio = narrationChanged || voiceChanged;

  return {
    ...scene,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.narration !== undefined ? { narration: patch.narration } : {}),
    ...(patch.durationSec !== undefined
      ? { durationSec: patch.durationSec }
      : {}),
    ...(patch.voice !== undefined ? { voice: patch.voice } : {}),
    ...(patch.qaNote !== undefined ? { qaNote: patch.qaNote } : {}),
    audioPath: invalidateAudio ? null : scene.audioPath,
    updatedAt: now ?? new Date().toISOString(),
  };
}
