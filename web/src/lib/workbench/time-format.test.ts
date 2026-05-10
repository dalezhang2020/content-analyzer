/**
 * Property tests for `time-format.ts`.
 *
 * Property 23: Relative-time formatter falls in the documented buckets.
 *
 * _Validates: Requirements 11.1_
 *
 * For any non-negative offset (seconds) between `then` and `now`, the
 * returned string:
 *   - matches EXACTLY one of the five documented patterns, and
 *   - the number extracted from it (where applicable) equals the bucket
 *     math `Math.floor(offset / unit)`.
 *
 * Pattern reference (design §Property 23 / Requirement 11.1):
 *   <60s                    → "刚刚"
 *   60..3599s               → "N 分钟前"
 *   3600..86399s            → "N 小时前"
 *   86400..(30d-1)s         → "N 天前"
 *   >=30d                   → "YYYY-MM-DD" (UTC of `then`)
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "@/lib/workbench/time-format";

const SEC = 1;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

const ABS_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_RE = /^(\d+) 分钟前$/;
const HOUR_RE = /^(\d+) 小时前$/;
const DAY_RE = /^(\d+) 天前$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function expectedAbsDate(then: Date): string {
  const y = then.getUTCFullYear();
  const m = pad2(then.getUTCMonth() + 1);
  const d = pad2(then.getUTCDate());
  return `${y}-${m}-${d}`;
}

describe("formatRelativeTime — Property 23", () => {
  it("returns a string that matches exactly one documented bucket and N is bucket math", () => {
    fc.assert(
      fc.property(
        // Arbitrary `then` timestamp in ms since epoch, kept inside a sane
        // range that JS `Date` handles identically across platforms.
        fc.integer({
          min: Date.UTC(1971, 0, 1),
          max: Date.UTC(2099, 11, 31),
        }),
        // Offset in seconds: 0..1 year. Covers all five buckets.
        fc.integer({ min: 0, max: YEAR }),
        (thenMs, offsetSec) => {
          const then = new Date(thenMs);
          const now = new Date(thenMs + offsetSec * 1000);

          const out = formatRelativeTime(now, then);

          // Exactly-one-bucket check: sum of matches must equal 1.
          const matches = [
            out === "刚刚",
            MIN_RE.test(out),
            HOUR_RE.test(out),
            DAY_RE.test(out),
            ABS_DATE_RE.test(out),
          ].filter(Boolean).length;
          expect(matches).toBe(1);

          if (offsetSec < 60) {
            expect(out).toBe("刚刚");
            return;
          }
          if (offsetSec < 3600) {
            const m = MIN_RE.exec(out);
            expect(m).not.toBeNull();
            expect(Number(m![1])).toBe(Math.floor(offsetSec / MIN));
            return;
          }
          if (offsetSec < 86400) {
            const m = HOUR_RE.exec(out);
            expect(m).not.toBeNull();
            expect(Number(m![1])).toBe(Math.floor(offsetSec / HOUR));
            return;
          }
          if (offsetSec < 30 * DAY) {
            const m = DAY_RE.exec(out);
            expect(m).not.toBeNull();
            expect(Number(m![1])).toBe(Math.floor(offsetSec / DAY));
            return;
          }
          // >=30d → UTC calendar date of `then`.
          expect(ABS_DATE_RE.test(out)).toBe(true);
          expect(out).toBe(expectedAbsDate(then));
        },
      ),
    );
  });
});
