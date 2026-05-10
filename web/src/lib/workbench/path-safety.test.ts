import { describe, expect, it } from "vitest";
import fc from "fast-check";
import path from "node:path";

import {
  hasPathTraversal,
  isValidProjectId,
  isValidSceneId,
  resolveProjectFile,
  scrubControlChars,
} from "@/lib/workbench/path-safety";
import {
  CONTROL_CHAR_REGEX,
  DATA_DIR,
  REGEX,
} from "@/lib/workbench/constants";
import { WorkbenchError } from "@/lib/workbench/errors";

// Feature: video-creation-workbench — T07.2 / T07.3
// Property-based tests for path-safety.ts. Fast-check's global seed / numRuns
// are pinned in src/test/setup.ts so failures reproduce deterministically.

// ---------------------------------------------------------------------------
// Property 11 — Path safety forbids traversal and honours id regex
// Validates: Requirements 2.3, 3.2, 8.7, 8.8, 16.4, 16.6
// ---------------------------------------------------------------------------

describe("path-safety — Property 11 (path safety forbids traversal and honours id regex)", () => {
  it("isValidProjectId matches REGEX.PROJECT_ID exactly for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(isValidProjectId(s)).toBe(REGEX.PROJECT_ID.test(s));
      }),
    );
  });

  it("isValidSceneId matches REGEX.SCENE_ID exactly for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(isValidSceneId(s)).toBe(REGEX.SCENE_ID.test(s));
      }),
    );
  });

  it("hasPathTraversal detects '..', absolute prefix ('/', '\\'), and NUL byte", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const expected =
          s.includes("..") ||
          s.startsWith("/") ||
          s.startsWith("\\") ||
          s.includes("\x00");
        expect(hasPathTraversal(s)).toBe(expected);
      }),
    );
  });

  it("hasPathTraversal flags '..' or NUL injected anywhere in the string", () => {
    // `..` and NUL are anywhere-markers — the implementation detects them
    // via `includes`, so sandwiching them between random padding must
    // always trip the guard.
    const anywhereMarker = fc.constantFrom("..", "\x00");
    fc.assert(
      fc.property(
        fc.string(),
        anywhereMarker,
        fc.string(),
        (prefix, marker, suffix) => {
          const combined = prefix + marker + suffix;
          expect(hasPathTraversal(combined)).toBe(true);
        },
      ),
    );
  });

  it("hasPathTraversal flags '/' or '\\' only when they lead the string", () => {
    // The absolute-path check is prefix-only: `startsWith("/")` or
    // `startsWith("\\")`. Any string that leads with either byte must be
    // flagged regardless of what follows.
    const leadingSeparator = fc.constantFrom("/", "\\");
    fc.assert(
      fc.property(leadingSeparator, fc.string(), (sep, rest) => {
        expect(hasPathTraversal(sep + rest)).toBe(true);
      }),
    );
  });

  it("resolveProjectFile throws WorkbenchError for any id that fails REGEX.PROJECT_ID", () => {
    // Random strings almost never match the canonical project-id shape, so
    // the filter is effectively a no-op in practice.
    fc.assert(
      fc.property(
        fc.string().filter((s) => !REGEX.PROJECT_ID.test(s)),
        (invalidId) => {
          expect(() => resolveProjectFile(invalidId)).toThrow(WorkbenchError);
        },
      ),
    );
  });

  it("resolveProjectFile produces a path under path.resolve(DATA_DIR) + path.sep for valid ids", () => {
    fc.assert(
      fc.property(fc.stringMatching(REGEX.PROJECT_ID), (validId) => {
        const resolved = resolveProjectFile(validId);
        const dataDirAbs = path.resolve(DATA_DIR);
        expect(resolved.startsWith(dataDirAbs + path.sep)).toBe(true);
        // Resolved path never carries the traversal markers we explicitly
        // reject at the input boundary.
        expect(resolved.includes("..")).toBe(false);
        expect(resolved.includes("\x00")).toBe(false);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12 — Control-character scrubber accepts iff input is clean
// Validates: Requirements 16.3
// ---------------------------------------------------------------------------

describe("path-safety — Property 12 (control-char scrubber accepts iff input is clean)", () => {
  it("scrubControlChars throws iff CONTROL_CHAR_REGEX matches (ASCII-range input)", () => {
    // Generate strings over the full ASCII range (0x00–0x7F) so control
    // bytes actually appear — fc.string() with default unit tops out at
    // printable chars. Mapping through String.fromCharCode is stable for
    // the basic ASCII plane.
    const asciiCharArb = fc
      .integer({ min: 0x00, max: 0x7f })
      .map((code) => String.fromCharCode(code));
    const asciiStringArb = fc.string({ unit: asciiCharArb });

    fc.assert(
      fc.property(asciiStringArb, (s) => {
        const hasControl = CONTROL_CHAR_REGEX.test(s);
        if (hasControl) {
          expect(() => scrubControlChars(s)).toThrow(WorkbenchError);
        } else {
          expect(scrubControlChars(s)).toBe(s);
        }
      }),
    );
  });

  it("scrubControlChars also holds for full-Unicode strings", () => {
    // Non-ASCII codepoints should pass through (they aren't in the
    // forbidden set); control bytes, wherever they land, must be rejected.
    fc.assert(
      fc.property(fc.string(), (s) => {
        const hasControl = CONTROL_CHAR_REGEX.test(s);
        if (hasControl) {
          expect(() => scrubControlChars(s)).toThrow(WorkbenchError);
        } else {
          expect(scrubControlChars(s)).toBe(s);
        }
      }),
    );
  });

  it("scrubControlChars throws whenever any forbidden byte is injected", () => {
    // Each byte in the spec's forbidden set must trigger rejection no
    // matter where it appears in the string.
    const forbiddenCharArb = fc.constantFrom(
      ..."\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x0F\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1A\x1B\x1C\x1D\x1E\x1F\x7F".split(
        "",
      ),
    );
    fc.assert(
      fc.property(
        fc.string(),
        forbiddenCharArb,
        fc.string(),
        (prefix, badByte, suffix) => {
          const combined = prefix + badByte + suffix;
          expect(() => scrubControlChars(combined)).toThrow(WorkbenchError);
        },
      ),
    );
  });

  it("scrubControlChars preserves the allowed whitespace bytes (TAB, LF, CR)", () => {
    // Per the implementation, 0x09 / 0x0A / 0x0D are deliberately NOT in
    // the forbidden set. Strings made only of these plus printable chars
    // must round-trip unchanged.
    const allowedWhitespaceArb = fc.constantFrom("\t", "\n", "\r");
    const printableCharArb = fc
      .integer({ min: 0x20, max: 0x7e })
      .map((code) => String.fromCharCode(code));
    const cleanStringArb = fc.string({
      unit: fc.oneof(printableCharArb, allowedWhitespaceArb),
    });

    fc.assert(
      fc.property(cleanStringArb, (s) => {
        expect(scrubControlChars(s)).toBe(s);
      }),
    );
  });
});
