import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { scanHtml } from "@/lib/workbench/html-scanner";
import { HTML_FORBIDDEN_TOKENS } from "@/lib/workbench/constants";

// Feature: video-creation-workbench — T11.2
//
// Property 13: HTML danger scanner rejects iff forbidden tokens are present.
// Validates Requirements 6.3, 16.7
//
// Forbidden tokens (per HTML_FORBIDDEN_TOKENS, case-insensitive):
//   <iframe, <object, <embed, fetch(, XMLHttpRequest, Date.now(, Math.random(
//
// The test exercises three slices of the property:
//   1. Token present (any casing, any position) ⇒ rejected.
//   2. Clean HTML built from a harmless-tag grammar ⇒ accepted.
//   3. Full bi-conditional over arbitrary strings ⇒ accepted iff no token.

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

const FORBIDDEN = HTML_FORBIDDEN_TOKENS;

/** Reference oracle: case-insensitive substring scan. */
function containsForbidden(s: string): boolean {
  const lower = s.toLowerCase();
  return FORBIDDEN.some((t) => lower.includes(t.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Produce a random per-char case mixing of `s`. Used to inject a forbidden
 * token with arbitrary capitalisation so we exercise the case-insensitive
 * behaviour of the scanner.
 */
function randomCaseArb(s: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: s.length, maxLength: s.length })
    .map((flips) =>
      s
        .split("")
        .map((c, i) => (flips[i] ? c.toUpperCase() : c.toLowerCase()))
        .join(""),
    );
}

/** Forbidden token paired with an arbitrary case variant of itself. */
const forbiddenTokenCasedArb: fc.Arbitrary<{
  canonical: string;
  cased: string;
}> = fc
  .constantFrom(...FORBIDDEN)
  .chain((canonical) =>
    randomCaseArb(canonical).map((cased) => ({ canonical, cased })),
  );

/**
 * Harmless tag names known to not share any substring with the forbidden
 * token set. (No `iframe`/`object`/`embed`, and no uppercase `X`/`D`/`M`
 * that could seed a forbidden-token prefix.)
 */
const harmlessTagArb = fc.constantFrom(
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "b",
  "i",
  "nav",
  "aside",
  "button",
);

/**
 * Inner text alphabet: plain ASCII letters, digits, whitespace, and
 * punctuation that cannot form any forbidden token prefix. Excludes `(`
 * and `<` so "fetch(", "Date.now(", "Math.random(", "<iframe", "<object",
 * "<embed" cannot be accidentally synthesised. `XMLHttpRequest` is still
 * theoretically reachable via letters alone, so we layer a final filter
 * on top.
 */
const safeCharArb = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \t\n,.:;!?'\"-+=/".split(
    "",
  ),
);

const safeTextArb = fc
  .stringOf(safeCharArb, { maxLength: 40 })
  .filter((s) => !containsForbidden(s));

const cleanElementArb = fc
  .tuple(harmlessTagArb, safeTextArb)
  .map(([tag, text]) => `<${tag}>${text}</${tag}>`);

/** HTML composed only of harmless tags; by construction has no forbidden token. */
const cleanHtmlArb = fc
  .array(cleanElementArb, { minLength: 0, maxLength: 8 })
  .map((parts) => parts.join(""))
  .filter((s) => !containsForbidden(s));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("html-scanner property tests (Property 13)", () => {
  /**
   * **Property 13 — rejection direction.**
   *
   * **Validates: Requirements 6.3, 16.7**
   *
   * For any clean base snippet, any forbidden token (in any casing), and
   * any insertion position, `scanHtml` must:
   *   - return `{ ok: false }`,
   *   - report a `hit` that is one of the canonical forbidden tokens, and
   *   - the lowercased `hit` must be a substring of the lowercased input.
   */
  it("rejects HTML containing any forbidden token (any case, any position)", () => {
    fc.assert(
      fc.property(
        cleanHtmlArb,
        forbiddenTokenCasedArb,
        fc.nat(),
        (base, token, rawPos) => {
          const pos = rawPos % (base.length + 1);
          const input = base.slice(0, pos) + token.cased + base.slice(pos);

          const result = scanHtml(input);
          expect(result.ok).toBe(false);
          if (result.ok === false) {
            expect(FORBIDDEN).toContain(result.hit);
            expect(input.toLowerCase()).toContain(result.hit.toLowerCase());
          }
        },
      ),
    );
  });

  /**
   * **Property 13 — acceptance direction (no false positives on clean HTML).**
   *
   * **Validates: Requirements 6.3, 16.7**
   *
   * HTML synthesised from a harmless-tag grammar — `<div>`, `<span>`,
   * `<p>`, etc. — must always pass the scanner.
   */
  it("accepts clean HTML built from harmless tags (no false positives)", () => {
    fc.assert(
      fc.property(cleanHtmlArb, (html) => {
        const result = scanHtml(html);
        expect(result.ok).toBe(true);
      }),
    );
  });

  /**
   * **Property 13 — full bi-conditional over arbitrary strings.**
   *
   * **Validates: Requirements 6.3, 16.7**
   *
   * For any string (including adversarial random Unicode), `scanHtml`
   * accepts iff no forbidden token appears (case-insensitive). When it
   * rejects, the `hit` must still be a canonical forbidden token and
   * match the input case-insensitively.
   */
  it("accepts iff no forbidden token appears (case-insensitive bi-conditional)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const result = scanHtml(s);
        const shouldReject = containsForbidden(s);

        expect(result.ok).toBe(!shouldReject);
        if (result.ok === false) {
          expect(FORBIDDEN).toContain(result.hit);
          expect(s.toLowerCase()).toContain(result.hit.toLowerCase());
        }
      }),
    );
  });
});
