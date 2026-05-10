/**
 * Video Creation Workbench — scene-rewrite acceptance rules.
 *
 * Two pure predicates backing the QA → rewrite loop:
 *
 *   • `validateSceneRewrite` decides whether the LLM's proposed
 *     `durationSec'` for a single Scene is acceptable given the old
 *     `durationSec` and the user-authored `qaNote`. The default policy
 *     is a ±30% tolerance; keywords in the QA note override the
 *     tolerance to allow explicit duration changes.
 *
 *   • `compositionRegenRequired` decides whether a Storyboard total
 *     drift after a rewrite is large enough to force a composition-HTML
 *     regeneration (>10%).
 *
 * These functions are fully pure — no I/O, no randomness, no clock —
 * and are exercised by property tests in
 * `./scene-rewrite-rules.test.ts` (Properties 19, 20).
 */

import { LIMITS, REWRITE_DURATION_KEYWORDS } from "./constants";

/**
 * Case-insensitive substring match of any entry in
 * `REWRITE_DURATION_KEYWORDS` against `qaNote`.
 *
 * The ASCII keywords are matched case-insensitively by lowercasing the
 * QA note before comparison. The Chinese keywords (`改时长`, `缩短`,
 * `加长`) are case-insensitive by nature — CJK characters have no
 * separate case — so `toLowerCase()` is a no-op on them.
 */
export function hasDurationKeyword(qaNote: string): boolean {
  const haystack = qaNote.toLowerCase();
  for (const keyword of REWRITE_DURATION_KEYWORDS) {
    if (haystack.includes(keyword)) {
      return true;
    }
  }
  return false;
}

/**
 * Accept the LLM's rewrite proposal when either
 *
 *   (a) `qaNote` contains an explicit duration-change keyword, in which
 *       case any `newDurationSec` is accepted (user opted into the
 *       change); or
 *   (b) the relative change is within
 *       `LIMITS.REWRITE_DURATION_TOLERANCE_PCT` (±30%) of the old
 *       duration.
 *
 * Edge case: when `oldDurationSec === 0`, the ratio is undefined. In
 * that case the rewrite is accepted only when `newDurationSec === 0`
 * as well (zero drift) — unless a keyword override applies — to avoid a
 * divide-by-zero surprise and to keep the predicate total.
 */
export function validateSceneRewrite(
  oldDurationSec: number,
  newDurationSec: number,
  qaNote: string,
): boolean {
  if (hasDurationKeyword(qaNote)) {
    return true;
  }
  if (oldDurationSec === 0) {
    return newDurationSec === 0;
  }
  const drift = Math.abs(newDurationSec - oldDurationSec) / oldDurationSec;
  return drift <= LIMITS.REWRITE_DURATION_TOLERANCE_PCT;
}

/**
 * A rewrite changes the composition HTML's implied total duration. If
 * the new storyboard total drifts by more than
 * `LIMITS.COMPOSITION_REGEN_THRESHOLD_PCT` (>10%) relative to the old
 * total, the composition HTML must be regenerated before rendering.
 *
 * Edge case: when `oldTotalSec === 0`, any non-zero new total counts as
 * a drift and triggers regen; `0 → 0` does not.
 */
export function compositionRegenRequired(
  oldTotalSec: number,
  newTotalSec: number,
): boolean {
  if (oldTotalSec === 0) {
    return newTotalSec !== 0;
  }
  const drift = Math.abs(newTotalSec - oldTotalSec) / oldTotalSec;
  return drift > LIMITS.COMPOSITION_REGEN_THRESHOLD_PCT;
}
