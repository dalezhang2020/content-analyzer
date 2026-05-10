/**
 * Video Creation Workbench — forbidden-token HTML scanner.
 *
 * Scans LLM-returned HTML (case-insensitively) for any substring from
 * {@link HTML_FORBIDDEN_TOKENS}. This is the last line of defence before
 * composition HTML is written to disk: if any forbidden token matches, the
 * caller rejects the output and the composition-stage repair loop kicks in.
 *
 * Intentionally implemented as a plain substring scanner (no HTML parser,
 * no DOM, no allocations beyond a single `toLowerCase()` of the input) so
 * it is fast, deterministic, and cannot be tricked by malformed markup.
 */

import { HTML_FORBIDDEN_TOKENS } from "./constants";

/**
 * Result of scanning an HTML string for forbidden tokens.
 *
 * - `{ ok: true }` — no forbidden token found.
 * - `{ ok: false, hit }` — first matching token, preserving the original
 *   casing as declared in {@link HTML_FORBIDDEN_TOKENS} (e.g. `"<iframe"`,
 *   `"XMLHttpRequest"`).
 */
export type HtmlScanResult =
  | { ok: true }
  | { ok: false; hit: string };

/**
 * Case-insensitive substring scan of `html` against
 * {@link HTML_FORBIDDEN_TOKENS}. Pure function: does not mutate its input
 * and performs a single `html.toLowerCase()` allocation.
 *
 * The returned `hit` is the token as declared in the forbidden list,
 * _not_ the substring as it appears in the input — callers logging the
 * result therefore see a stable, canonical token string.
 */
export function scanHtml(html: string): HtmlScanResult {
  const lowered = html.toLowerCase();
  for (const token of HTML_FORBIDDEN_TOKENS) {
    if (lowered.includes(token.toLowerCase())) {
      return { ok: false, hit: token };
    }
  }
  return { ok: true };
}
