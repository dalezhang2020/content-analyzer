/**
 * Video Creation Workbench — scene-rewrite-rules property tests (T16.2).
 *
 * Validates the two pure predicates that back the QA → rewrite loop:
 *
 *   • Property 19 — `validateSceneRewrite(d, d', qaNote)` accepts iff
 *     (a) `qaNote` (case-insensitive) contains any of
 *         `{改时长, change duration, 缩短, 加长, shorten, lengthen}`, OR
 *     (b) `|d' - d| / d ≤ 0.3`.
 *
 *   • Property 20 — `compositionRegenRequired(T, T')` iff
 *     `|T' - T| / T > 0.10`.
 *
 * Fast-check globals (`seed: 0xbeef`, `numRuns: 100`) are configured in
 * `src/test/setup.ts`.
 *
 * _Validates: Requirements 7.3, 7.5_
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { LIMITS, REWRITE_DURATION_KEYWORDS } from "./constants";
import {
  compositionRegenRequired,
  validateSceneRewrite,
} from "./scene-rewrite-rules";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Scene duration in the general Scene bounds (1–60s). A finite, non-NaN,
 * strictly positive double — the divide-by-zero branch of
 * `validateSceneRewrite` is out of scope for Property 19 which requires
 * `d, d' ∈ [1, 60]`.
 */
const durationArb = fc.double({
  min: LIMITS.SCENE_DURATION_MIN, // 1
  max: LIMITS.SCENE_DURATION_MAX, // 60
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * Storyboard total duration. At N scenes × (1..60)s with N ∈ [3, 20],
 * totals land in [3, 1200]. We draw from that range (strictly positive)
 * to stay inside the defined branch of `compositionRegenRequired`.
 */
const totalDurationArb = fc.double({
  min: LIMITS.STORYBOARD_MIN_SCENES * LIMITS.SCENE_DURATION_MIN, // 3
  max: LIMITS.STORYBOARD_MAX_SCENES * LIMITS.SCENE_DURATION_MAX, // 1200
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * Independent re-implementation of the "contains a duration keyword"
 * predicate straight from the spec, so Property 19 is checking the
 * implementation against the Requirement text rather than against the
 * SUT's own helper.
 *
 * _Requirements: 7.3_
 */
function specContainsDurationKeyword(qaNote: string): boolean {
  const haystack = qaNote.toLowerCase();
  return REWRITE_DURATION_KEYWORDS.some((kw) => haystack.includes(kw));
}

// ---------------------------------------------------------------------------
// Property 19 — Scene-rewrite duration acceptance bounds
// ---------------------------------------------------------------------------

describe("scene-rewrite-rules — Property 19", () => {
  it("validateSceneRewrite accepts iff qaNote has a duration keyword OR |d'-d|/d ≤ 0.3", () => {
    fc.assert(
      fc.property(
        durationArb,
        durationArb,
        // Arbitrary free-form QA note.
        fc.string({ maxLength: 100 }),
        // Flag controlling whether we splice a keyword into the note.
        // Serves to bias the distribution toward both branches of the
        // predicate; the actual keyword-presence check is done post-hoc.
        fc.boolean(),
        fc.constantFrom(...REWRITE_DURATION_KEYWORDS),
        // Case toggle so we exercise case-insensitivity on the ASCII
        // keywords (CJK keywords are unaffected by `toUpperCase`).
        fc.boolean(),
        (d, dPrime, baseNote, injectKeyword, keyword, uppercaseKeyword) => {
          const spliced = uppercaseKeyword ? keyword.toUpperCase() : keyword;
          const qaNote = injectKeyword ? `${baseNote} ${spliced}` : baseNote;

          const actual = validateSceneRewrite(d, dPrime, qaNote);

          if (specContainsDurationKeyword(qaNote)) {
            // (a) Keyword override — any d' is accepted.
            expect(actual).toBe(true);
            return;
          }

          // (b) Tolerance branch. `d ∈ [1, 60]` so `d > 0` and the ratio
          // is defined; we reproduce the SUT's arithmetic exactly so
          // floating-point quirks (if any) match on both sides of the
          // equation.
          const drift = Math.abs(dPrime - d) / d;
          const expected = drift <= LIMITS.REWRITE_DURATION_TOLERANCE_PCT;
          expect(actual).toBe(expected);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 20 — compositionRegenRequired tracks total-duration drift
// ---------------------------------------------------------------------------

describe("scene-rewrite-rules — Property 20", () => {
  it("compositionRegenRequired(T, T') iff |T'-T|/T > 0.10", () => {
    fc.assert(
      fc.property(totalDurationArb, totalDurationArb, (t, tPrime) => {
        const drift = Math.abs(tPrime - t) / t;
        const expected = drift > LIMITS.COMPOSITION_REGEN_THRESHOLD_PCT;
        expect(compositionRegenRequired(t, tPrime)).toBe(expected);
      }),
    );
  });
});
