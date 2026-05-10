// Relative time formatter for the video creation workbench.
// Pure function. No side effects. Uses UTC for the absolute date fallback
// so output is deterministic across environments.

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Format the elapsed time between `then` and `now` as a human-readable
 * Chinese relative time string.
 *
 * Buckets (per Requirement 11.1, Property 23):
 *   < 60s              → "刚刚"
 *   < 1h               → "N 分钟前"
 *   < 1d               → "N 小时前"
 *   < 30d              → "N 天前"
 *   otherwise          → "YYYY-MM-DD" (UTC)
 *
 * If `then` is in the future relative to `now`, the delta is clamped to 0
 * (i.e. returns "刚刚").
 */
export function formatRelativeTime(
  now: Date | string,
  then: Date | string,
): string {
  const nowDate = toDate(now);
  const thenDate = toDate(then);

  const nowMs = nowDate.getTime();
  const thenMs = thenDate.getTime();

  const rawDelta = nowMs - thenMs;
  const deltaMs = rawDelta < 0 ? 0 : rawDelta;
  const deltaSec = Math.floor(deltaMs / 1000);

  if (deltaSec < 60) {
    return "刚刚";
  }
  if (deltaSec < 3600) {
    return `${Math.floor(deltaSec / 60)} 分钟前`;
  }
  if (deltaSec < 86400) {
    return `${Math.floor(deltaSec / 3600)} 小时前`;
  }
  if (deltaSec < 30 * 86400) {
    return `${Math.floor(deltaSec / 86400)} 天前`;
  }

  const year = thenDate.getUTCFullYear();
  const month = pad2(thenDate.getUTCMonth() + 1);
  const day = pad2(thenDate.getUTCDate());
  return `${year}-${month}-${day}`;
}
