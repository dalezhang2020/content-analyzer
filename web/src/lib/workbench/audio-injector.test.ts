/**
 * Property-based tests for `audio-injector.ts`.
 *
 * Property 14: Audio injection inserts exactly the successful scenes and is
 * perfectly reversible.
 *
 * **Validates: Requirements 9.10, 9.11, 9.12**
 *
 * Two complementary properties are asserted over randomised storyboards and
 * `successfulIndexes` subsets:
 *
 *   Property A — bijection:
 *     After `injectAudio`, the HTML contains exactly one canonical
 *     `<audio ... src="assets/scene-{i}.mp3" ...>` tag for each
 *     `i ∈ successfulIndexes`, and zero tags for any index not in the
 *     successful set.
 *
 *   Property B — reversibility:
 *     `injectAudio` is idempotent (applying it twice yields the same HTML),
 *     and stripping every injected `<audio data-scene-index="…">` tag from
 *     the injected HTML restores the original HTML byte-for-byte (when the
 *     original HTML contains no such tags to begin with).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { injectAudio } from "@/lib/workbench/audio-injector";
import type { Scene, Storyboard } from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Build a Scene arbitrary for a fixed 1-based index. Only the fields that
 * `injectAudio` reads (`index`, `durationSec`) need realistic values; other
 * fields are filled with deterministic placeholders to keep shrinks fast.
 */
function sceneForIndexArb(index: number): fc.Arbitrary<Scene> {
  return fc.record({
    sceneId: fc
      .hexaString({ minLength: 8, maxLength: 8 })
      .map((h) => `sc_${h}`),
    index: fc.constant(index),
    title: fc.constant(`Scene ${index}`),
    narration: fc.constant("narration"),
    durationSec: fc.integer({ min: 1, max: 60 }),
    voice: fc.constant("zh-CN-Xiaochen:DragonHDFlashLatestNeural"),
    audioPath: fc.constant(null),
    qaNote: fc.constant(""),
    updatedAt: fc.constant("2025-01-01T00:00:00Z"),
  });
}

/**
 * Storyboard arbitrary — 3..20 scenes with contiguous 1-based indexes.
 * Matches the MIN_SCENES/MAX_SCENES invariant from Req 3 so we only exercise
 * valid storyboards.
 */
const storyboardArb: fc.Arbitrary<Storyboard> = fc
  .integer({ min: 3, max: 20 })
  .chain((n) =>
    fc
      .tuple(...Array.from({ length: n }, (_, i) => sceneForIndexArb(i + 1)))
      .map((scenes) => ({ scenes: scenes as Scene[] })),
  );

/**
 * Random subset of the scene indexes (may be empty or full). fast-check's
 * `subarray` preserves order, but the implementation treats the input as a
 * set so order is irrelevant for the properties under test.
 */
function successfulIndexesArb(n: number): fc.Arbitrary<number[]> {
  return fc.subarray(Array.from({ length: n }, (_, i) => i + 1));
}

/**
 * Minimal HyperFrames-style HTML templates. None of them contain any
 * `<audio data-scene-index="…">` tag or the substring `assets/scene-N.mp3`,
 * so post-injection counts can be attributed entirely to the injector.
 */
const baseHtmlArb: fc.Arbitrary<string> = fc.constantFrom(
  '<!DOCTYPE html><html><head><title>T</title></head><body><main></main></body></html>',
  '<html><body><div class="scene" data-scene="1"></div></body></html>',
  "<!DOCTYPE html><html><body></body></html>",
  '<div class="scene" data-scene="1"></div><div class="scene" data-scene="2"></div>',
  "",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Same shape as the implementation's internal AUDIO_TAG_RE — matches any
 * `<audio … data-scene-index="N" …>` with an optional `</audio>` closer,
 * case-insensitively. Used by the reversibility property to strip injected
 * tags.
 */
const AUDIO_TAG_RE =
  /<audio\s+[^>]*?\bdata-scene-index="(\d+)"[^>]*?>(?:<\/audio>)?/gi;

/** Count occurrences of a (non-regex) literal substring. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const hit = haystack.indexOf(needle, from);
    if (hit < 0) return count;
    count += 1;
    from = hit + needle.length;
  }
}

// ---------------------------------------------------------------------------
// Property 14 — bijection + reversibility
// ---------------------------------------------------------------------------

describe("audio-injector: Property 14 (bijection + reversibility)", () => {
  it("Property A — bijection: one canonical tag per successful index, none otherwise", () => {
    fc.assert(
      fc.property(
        storyboardArb.chain((sb) =>
          fc.tuple(
            fc.constant(sb),
            successfulIndexesArb(sb.scenes.length),
            baseHtmlArb,
          ),
        ),
        ([sb, successful, html]) => {
          const out = injectAudio(html, sb, successful);
          const successfulSet = new Set(successful);
          const allIndexes = sb.scenes.map((s) => s.index);

          for (const i of allIndexes) {
            const marker = `src="assets/scene-${i}.mp3"`;
            const count = countOccurrences(out, marker);
            const expected = successfulSet.has(i) ? 1 : 0;
            expect(count).toBe(expected);
          }
        },
      ),
    );
  });

  it("Property B1 — idempotence: injectAudio(injectAudio(x)) === injectAudio(x)", () => {
    fc.assert(
      fc.property(
        storyboardArb.chain((sb) =>
          fc.tuple(
            fc.constant(sb),
            successfulIndexesArb(sb.scenes.length),
            baseHtmlArb,
          ),
        ),
        ([sb, successful, html]) => {
          const once = injectAudio(html, sb, successful);
          const twice = injectAudio(once, sb, successful);
          expect(twice).toBe(once);
        },
      ),
    );
  });

  it("Property B2 — reversibility: stripping injected <audio> tags restores the original HTML", () => {
    fc.assert(
      fc.property(
        storyboardArb.chain((sb) =>
          fc.tuple(
            fc.constant(sb),
            successfulIndexesArb(sb.scenes.length),
            baseHtmlArb,
          ),
        ),
        ([sb, successful, html]) => {
          // Precondition guard: the generator must not yield pre-existing
          // `<audio data-scene-index="…">` tags. If this ever changes, the
          // property no longer applies — keep the check so a bad generator
          // surfaces as a loud failure rather than a silent false positive.
          expect(html.match(AUDIO_TAG_RE)).toBeNull();

          const injected = injectAudio(html, sb, successful);
          const stripped = injected.replace(AUDIO_TAG_RE, "");
          expect(stripped).toBe(html);
        },
      ),
    );
  });
});
