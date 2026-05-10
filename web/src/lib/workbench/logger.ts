/**
 * Video Creation Workbench — per-stage JSON-line logger.
 *
 * Every external-call or stage-transition event flows through this module.
 * Logs are written as one JSON object per line to
 * `data/projects/{projectId}/logs/{stage}.log`, rotated when a single file
 * exceeds `LIMITS.LOG_FILE_MAX_BYTES`, and redacted against environment-
 * variable-shaped secrets before being serialised.
 *
 * Design guarantees:
 *   - `info` / `warn` / `error` NEVER throw — write failures are swallowed
 *     and surfaced via `console.error` so a failing log device cannot crash
 *     a request handler.
 *   - `timed` is the ONLY entry point that re-throws; it still logs an
 *     `{ level: "error", durationMs, error }` line before propagating.
 *   - Concurrent log calls against the same file are serialised via a
 *     module-level promise queue so line writes never interleave.
 *   - A bad `projectId` (missing, malformed, traversal-looking) is redirected
 *     to `data/projects/_invalid/logs/{stage}.log` rather than throwing, so
 *     the logger itself is never a source of new failures.
 */

import path from "node:path";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";

import { LIMITS, REGEX, STAGE_DIRS } from "./constants";
import { getDataDirAbs } from "./path-safety";
import type { Stage } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoggerStage = Stage | "system";

export interface WorkbenchLogger {
  info(event: string, data?: Record<string, unknown>): Promise<void>;
  warn(event: string, data?: Record<string, unknown>): Promise<void>;
  error(event: string, data?: Record<string, unknown>): Promise<void>;
  timed<T>(
    event: string,
    fn: () => Promise<T>,
    data?: Record<string, unknown>,
  ): Promise<T>;
}

type LogLevel = "info" | "warn" | "error";

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACTED = "***REDACTED***";
const MIN_SECRET_LEN = 16;
const MAX_REDACT_DEPTH = 5;

/**
 * Snapshot of environment-variable values long enough to plausibly be
 * secrets, computed ONCE at module load. Later mutation of `process.env`
 * is intentionally ignored — secret values the process was started with
 * are the only ones that could already have flowed into log payloads at
 * startup time.
 */
const SECRET_VALUES: readonly string[] = Object.values(process.env).filter(
  (v): v is string => typeof v === "string" && v.length >= MIN_SECRET_LEN,
);

const SECRET_SET: ReadonlySet<string> = new Set(SECRET_VALUES);

/**
 * True if `s` is a known secret or contains one as a substring.
 * Substring matching guards against cases like
 * `"Authorization: Bearer sk-xxxxxx"` where only part of the string is the
 * secret itself.
 */
function containsSecret(s: string): boolean {
  if (SECRET_SET.has(s)) return true;
  for (const secret of SECRET_VALUES) {
    // Defensive — empty strings are filtered out already, but `indexOf` on
    // an empty string would match trivially.
    if (secret.length >= MIN_SECRET_LEN && s.includes(secret)) return true;
  }
  return false;
}

/**
 * Recursively walk `value` (max depth `MAX_REDACT_DEPTH`) and replace any
 * string that matches a known secret with `"***REDACTED***"`. Non-string
 * leaves are returned unchanged.
 *
 * Cycles and over-deep payloads short-circuit to a marker rather than
 * throwing — the logger must never fail on pathological inputs.
 */
function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[MAX_DEPTH]";
  if (typeof value === "string") {
    return containsSecret(value) ? REDACTED : value;
  }
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, depth + 1);
  }
  return out;
}

/**
 * Redact a `data` payload without touching the reserved envelope fields
 * (`ts`, `level`, `stage`, `event`, `durationMs`) — those are safe literal
 * identifiers produced by the logger itself.
 */
function redactData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data) return {};
  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    redacted[k] = redactValue(v, 1);
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const INVALID_PROJECT_BUCKET = "_invalid";

/**
 * Resolve the absolute log file path for `(projectId, stage)`. A malformed
 * `projectId` is funneled into `_invalid/` rather than causing a throw.
 */
function resolveLogPath(projectId: string, stage: LoggerStage): string {
  const safeId =
    typeof projectId === "string" && REGEX.PROJECT_ID.test(projectId)
      ? projectId
      : INVALID_PROJECT_BUCKET;

  return path.resolve(
    getDataDirAbs(),
    safeId,
    STAGE_DIRS.LOGS,
    `${stage}.log`,
  );
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Rotate `{stage}.log` through `{stage}.log.1` → `{stage}.log.2` →
 * `{stage}.log.3`, dropping anything beyond `LIMITS.LOG_HISTORY_MAX`.
 *
 * Each rename swallows `ENOENT` (missing source) and logs any other failure
 * to `console.error`. Rotation is best-effort — if a shift fails we still
 * append to the base file, accepting that one rotation cycle may be lost.
 */
async function rotateIfNeeded(logPath: string): Promise<void> {
  let size: number;
  try {
    const s = await stat(logPath);
    size = s.size;
  } catch (err) {
    // File does not exist yet — nothing to rotate.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    console.error(
      `[workbench-logger] rotate: stat failed for ${logPath}:`,
      err,
    );
    return;
  }

  if (size <= LIMITS.LOG_FILE_MAX_BYTES) return;

  // Drop anything strictly above LOG_HISTORY_MAX first (defensive cleanup).
  // Shift `log.(N-1) → log.N` for N from LOG_HISTORY_MAX down to 2, deleting
  // `log.N` beforehand so `rename` has a clear slot.
  for (let n = LIMITS.LOG_HISTORY_MAX; n >= 2; n--) {
    const target = `${logPath}.${n}`;
    const source = `${logPath}.${n - 1}`;

    // Unlink the target slot (ignore ENOENT).
    try {
      await unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error(
          `[workbench-logger] rotate: unlink ${target} failed:`,
          err,
        );
      }
    }

    // Rename source into target slot (ignore ENOENT — source may not exist).
    try {
      await rename(source, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error(
          `[workbench-logger] rotate: rename ${source} -> ${target} failed:`,
          err,
        );
      }
    }
  }

  // Finally, move the live log to `.1`.
  try {
    await rename(logPath, `${logPath}.1`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(
        `[workbench-logger] rotate: rename ${logPath} -> ${logPath}.1 failed:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Per-file write queue
// ---------------------------------------------------------------------------

/**
 * Chain of pending writes per absolute log path. Each `append` chains off
 * the tail of this promise so concurrent callers cannot interleave partial
 * lines. Errors are swallowed on the chain itself — `append` reports them
 * via `console.error` — so one failed write does not poison the queue.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(
  logPath: string,
  task: () => Promise<void>,
): Promise<void> {
  const prev = writeQueues.get(logPath) ?? Promise.resolve();
  const next = prev.then(task, task); // run task regardless of prior errors
  writeQueues.set(logPath, next);
  // Clean the map entry once this task settles, but only if nothing newer
  // has been enqueued in the meantime.
  void next.finally(() => {
    if (writeQueues.get(logPath) === next) {
      writeQueues.delete(logPath);
    }
  });
  return next;
}

// ---------------------------------------------------------------------------
// Core append
// ---------------------------------------------------------------------------

interface LogEnvelope {
  ts: string;
  level: LogLevel;
  stage: LoggerStage;
  event: string;
  durationMs?: number;
  [key: string]: unknown;
}

async function writeLine(
  logPath: string,
  envelope: LogEnvelope,
): Promise<void> {
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await rotateIfNeeded(logPath);
    const line = `${JSON.stringify(envelope)}\n`;
    await appendFile(logPath, line, "utf8");
  } catch (err) {
    console.error(`[workbench-logger] write failed for ${logPath}:`, err);
  }
}

function append(
  logPath: string,
  stage: LoggerStage,
  level: LogLevel,
  event: string,
  data: Record<string, unknown> | undefined,
  extra?: Record<string, unknown>,
): Promise<void> {
  // `extra` is logger-generated (durationMs, error) but still goes through
  // redaction because external error messages can contain secret values
  // (e.g. "Bearer sk-xxxxxx: 401 Unauthorized").
  const envelope: LogEnvelope = {
    ts: new Date().toISOString(),
    level,
    stage,
    event,
    ...redactData(data),
    ...redactData(extra),
  };
  return enqueueWrite(logPath, () => writeLine(logPath, envelope));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `WorkbenchLogger` bound to `(projectId, stage)`. The returned
 * object is cheap — safe to construct per-request.
 *
 * On Vercel (non-local env), returns a console-only logger since the
 * local filesystem is read-only.
 */
export function createLogger(
  projectId: string,
  stage: LoggerStage,
): WorkbenchLogger {
  // On Vercel: no persistent filesystem — log to console only.
  if (process.env.VERCEL) {
    const prefix = `[workbench:${stage}:${projectId}]`;
    const noop = async (event: string, data?: Record<string, unknown>) => {
      console.log(prefix, event, data ? JSON.stringify(redactData(data)) : "");
    };
    return {
      info: noop,
      warn: async (event, data) => {
        console.warn(prefix, event, data ? JSON.stringify(redactData(data)) : "");
      },
      error: async (event, data) => {
        console.error(prefix, event, data ? JSON.stringify(redactData(data)) : "");
      },
      async timed<T>(
        event: string,
        fn: () => Promise<T>,
        data?: Record<string, unknown>,
      ): Promise<T> {
        const start = Date.now();
        try {
          const result = await fn();
          console.log(prefix, event, JSON.stringify({ ...redactData(data), durationMs: Date.now() - start }));
          return result;
        } catch (err) {
          const durationMs = Date.now() - start;
          const message = err instanceof Error ? err.message.slice(0, 500) : String(err);
          console.error(prefix, event, JSON.stringify({ ...redactData(data), durationMs, error: { message } }));
          throw err;
        }
      },
    };
  }

  const logPath = resolveLogPath(projectId, stage);

  return {
    info(event, data) {
      return append(logPath, stage, "info", event, data);
    },
    warn(event, data) {
      return append(logPath, stage, "warn", event, data);
    },
    error(event, data) {
      return append(logPath, stage, "error", event, data);
    },
    async timed<T>(
      event: string,
      fn: () => Promise<T>,
      data?: Record<string, unknown>,
    ): Promise<T> {
      const start = Date.now();
      try {
        const result = await fn();
        const durationMs = Date.now() - start;
        await append(logPath, stage, "info", event, data, { durationMs });
        return result;
      } catch (err) {
        const durationMs = Date.now() - start;
        const name =
          err instanceof Error && typeof err.name === "string"
            ? err.name
            : "Error";
        const rawMessage =
          err instanceof Error && typeof err.message === "string"
            ? err.message
            : String(err);
        const message = rawMessage.slice(0, 500);
        await append(logPath, stage, "error", event, data, {
          durationMs,
          error: { message, name },
        });
        throw err;
      }
    },
  };
}
