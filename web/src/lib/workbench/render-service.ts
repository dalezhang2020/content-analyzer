/**
 * Video Creation Workbench — HyperFrames subprocess + SSE event iterator.
 *
 * Owns the entire render lifecycle for a Project:
 *   1. Rename the previous `public/videos/project-{id}.mp4` → `.prev.mp4`
 *      before spawn so the next run has a clean output target.
 *   2. Spawn `npx --yes hyperframes@0.5.5 render --output {abs} --fps 30`
 *      inside the project's `composition/` directory (OD-7).
 *   3. Line-buffer stdout/stderr via `readline`, mirroring each line into
 *      the per-project render log and broadcasting `{ type: "line" }` SSE
 *      events to every subscriber.
 *   4. Emit `{ type: "stage", stage: ... }` markers from regex hints on
 *      stdout (`/render/i` → rendering, `/encod/i` → encoding) and on
 *      terminal transitions (starting / done / failed).
 *   5. Enforce `TIMEOUTS_MS.HYPERFRAMES_RENDER` wall-clock; on timeout,
 *      kill the child and surface `RENDER_TIMEOUT`.
 *   6. On exit, validate the mp4 file exists and is non-empty before
 *      publishing `videoPath`; otherwise surface an error with the
 *      stderr tail.
 *   7. Offer a companion `subscribeRender` async iterable that replays
 *      the full `events` buffer to late joiners and then tails new events
 *      until the terminal stage event is emitted.
 *
 * `runHyperframesLint` / `runHyperframesValidate` are one-shot spawn
 * helpers used by the composition repair loop; they share the same
 * timeout scaffolding but never broadcast SSE events.
 *
 * _Requirements: 10.1, 10.4–10.11; OD-7_
 */

import { randomBytes } from "node:crypto";
import {
  type ChildProcess,
  spawn,
  type SpawnOptions,
} from "node:child_process";
import { rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { ensureDir, fileExists } from "./atomic-fs";
import {
  LIMITS,
  STAGE_DIRS,
  TIMEOUTS_MS,
  VIDEO_DIR,
} from "./constants";
import { ErrorCode, WorkbenchError } from "./errors";
import { createLogger } from "./logger";
import { resolveProjectFile } from "./path-safety";
import type { Project, RenderEvent } from "./types";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * In-memory handle for a running (or recently completed) render. Exposes
 * everything the route handlers need to drive the SSE stream, poll status,
 * or abort mid-flight. Persisted only for the lifetime of the Node process
 * — renders are not resumable across restarts.
 */
export interface ActiveRender {
  runId: string;
  projectId: string;
  /** ISO 8601 UTC timestamp of spawn. */
  startedAt: string;
  status: "running" | "done" | "failed";
  /**
   * Append-only log of every event emitted for this render so late
   * subscribers can replay the stream. Includes starting / line / stage
   * / heartbeat frames in the order they happened.
   */
  events: RenderEvent[];
  /** Public URL (e.g. `/videos/project-xxx.mp4`), set on successful exit. */
  videoPath: string | null;
  /** Populated when `status === "failed"` to drive the HTTP error envelope. */
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Keyed by `projectId` — only one live render per project at a time. */
const activeRenders = new Map<string, ActiveRender>();

/**
 * Per-project listeners that wake up any pending `subscribeRender` async
 * generator when new events arrive. The listener itself is a simple "ping"
 * — the generator reads the actual event data from `active.events`.
 */
const subscribers = new Map<string, Set<(ev: RenderEvent) => void>>();

/** Child handles so `killRender` can send signals to the right subprocess. */
const childProcesses = new Map<string, ChildProcess>();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pin per design OD-7 so rendering is reproducible. */
const HYPERFRAMES_CLI = "hyperframes@0.5.5";

/** Cap lines pushed to the event stream to avoid runaway log payloads. */
const LINE_MAX_CHARS = 500;

/** Cap how many stderr lines we retain for the failure-message tail. */
const STDERR_TAIL_LINES = 20;

/** Soft delay between SIGTERM and SIGKILL in `killRender`. */
const KILL_GRACE_MS = 2_000;

/**
 * Public `/videos/...` URL prefix. Derived from `VIDEO_DIR` so changes to
 * that constant stay in one place, but we strip the `public/` prefix
 * because Next.js serves `public/` at the site root.
 */
const PUBLIC_VIDEO_URL_PREFIX = `/${VIDEO_DIR.replace(/^public\//, "")}`;

// ---------------------------------------------------------------------------
// Event plumbing
// ---------------------------------------------------------------------------

/**
 * Append an event to the ActiveRender's buffer AND notify every subscriber.
 * Subscribers are only "woken up" — the actual event data is drained by the
 * subscriber from `active.events` (keeps the broadcast side cheap and avoids
 * per-subscriber queues).
 */
function emitEvent(active: ActiveRender, ev: RenderEvent): void {
  active.events.push(ev);
  const subs = subscribers.get(active.projectId);
  if (!subs) return;
  for (const notify of subs) {
    try {
      notify(ev);
    } catch (err) {
      // A failing subscriber callback must not poison the broadcast.
      console.error("[render-service] subscriber notify failed:", err);
    }
  }
}

/** ISO 8601 UTC "now" helper to keep event creation terse. */
function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// startRender
// ---------------------------------------------------------------------------

/**
 * Spawn `hyperframes render` for `project`, wire stdout/stderr into the SSE
 * event stream + render log, enforce the render timeout, and return the
 * in-memory `ActiveRender` handle.
 *
 * The route handler is responsible for stage gating (`stage === "audio"`)
 * and for rejecting concurrent-render conflicts. Here we simply guard
 * against the rare re-entry where an old active record is still in
 * `running` state — callers that want the project-level 409 should check
 * `getActiveRender(projectId)?.status === "running"` before calling.
 *
 * _Requirements: 10.1, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11_
 */
export async function startRender(
  project: Project,
): Promise<{ runId: string; active: ActiveRender }> {
  const projectId = project.projectId;

  // Compute filesystem paths. `resolveProjectFile` enforces traversal and
  // project-id validation; it throws `WorkbenchError(INVALID_PROJECT_ID)`
  // or `PATH_TRAVERSAL_REJECTED` for bad inputs.
  const compositionDir = resolveProjectFile(projectId, STAGE_DIRS.COMPOSITION);
  const outputAbs = path.resolve(
    process.cwd(),
    VIDEO_DIR,
    `project-${projectId}.mp4`,
  );
  const prevAbs = outputAbs.replace(/\.mp4$/, ".prev.mp4");

  // Requirement 10.4: rename the existing output to `.prev.mp4` before the
  // spawn so `hyperframes render --output` has a clean slot to write into.
  // Any failure here is surfaced as `PREV_RENAME_FAILED` (500).
  if (await fileExists(outputAbs)) {
    try {
      await rename(outputAbs, prevAbs);
    } catch (err) {
      throw new WorkbenchError(
        ErrorCode.PREV_RENAME_FAILED,
        `Failed to rename previous mp4: ${(err as Error)?.message ?? String(err)}`,
        { outputAbs, prevAbs },
      );
    }
  }
  await ensureDir(path.dirname(outputAbs));

  // `render_{ms-timestamp}_{6 hex}` — local-only ID, not persisted to the
  // project JSON. Useful for logs + telemetry.
  const runId = `render_${Date.now()}_${randomBytes(3).toString("hex")}`;

  const active: ActiveRender = {
    runId,
    projectId,
    startedAt: nowIso(),
    status: "running",
    events: [],
    videoPath: null,
  };
  activeRenders.set(projectId, active);

  const logger = createLogger(projectId, "render");

  // Emit the first "starting" marker immediately so UIs that open the SSE
  // stream before any subprocess output arrives still see progress.
  emitEvent(active, { type: "stage", stage: "starting", at: nowIso() });

  // --- subprocess wiring -------------------------------------------------

  const spawnOpts: SpawnOptions = {
    cwd: compositionDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  };
  const spawnArgs = [
    "--yes",
    HYPERFRAMES_CLI,
    "render",
    "--output",
    outputAbs,
    "--fps",
    String(LIMITS.RENDER_FPS),
  ];

  let child: ChildProcess;
  try {
    child = spawn("npx", spawnArgs, spawnOpts);
  } catch (err) {
    // Synchronous spawn errors (arg-shape problems, for example) — treat
    // the render as failed before any subscriber could attach.
    finalizeFailure(active, null, {
      code: ErrorCode.UNKNOWN,
      message: `spawn failed: ${(err as Error)?.message ?? String(err)}`.slice(
        0,
        LIMITS.ERROR_MESSAGE_MAX,
      ),
    });
    void logger.error("render_spawn_failed", { error: String(err) });
    return { runId, active };
  }
  childProcesses.set(projectId, child);

  // Tracks whether the subprocess was killed because of our timeout so the
  // exit handler can map the exit to `RENDER_TIMEOUT` rather than a generic
  // non-zero-exit failure.
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  let heartbeatHandle: NodeJS.Timeout | null = null;
  /** Rolling window of the last N stderr lines for the failure message. */
  const stderrTail: string[] = [];
  /** Emitted stage hints so we don't replay `rendering` on every line. */
  const emittedStages = new Set<string>();

  const clearTimers = (): void => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (heartbeatHandle) {
      clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
  };

  // --- stdout / stderr line streaming -----------------------------------

  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const truncated = line.slice(0, LINE_MAX_CHARS);
      emitEvent(active, { type: "line", line: truncated, at: nowIso() });
      void logger.info("render_line", { line: truncated, stream: "stdout" });

      // Coarse stage detection from stdout hints.
      if (!emittedStages.has("rendering") && /render/i.test(line)) {
        emittedStages.add("rendering");
        emitEvent(active, {
          type: "stage",
          stage: "rendering",
          at: nowIso(),
        });
      } else if (!emittedStages.has("encoding") && /encod/i.test(line)) {
        emittedStages.add("encoding");
        emitEvent(active, {
          type: "stage",
          stage: "encoding",
          at: nowIso(),
        });
      }
    });
    rl.on("error", (err) => {
      console.error("[render-service] stdout readline error:", err);
    });
  }

  if (child.stderr) {
    const rl = readline.createInterface({ input: child.stderr });
    rl.on("line", (line) => {
      const truncated = line.slice(0, LINE_MAX_CHARS);
      stderrTail.push(truncated);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      emitEvent(active, { type: "line", line: truncated, at: nowIso() });
      void logger.info("render_line", { line: truncated, stream: "stderr" });
    });
    rl.on("error", (err) => {
      console.error("[render-service] stderr readline error:", err);
    });
  }

  // --- heartbeat --------------------------------------------------------

  heartbeatHandle = setInterval(() => {
    if (active.status !== "running") {
      clearTimers();
      return;
    }
    emitEvent(active, { type: "heartbeat", at: nowIso() });
  }, TIMEOUTS_MS.SSE_HEARTBEAT_INTERVAL);

  // --- timeout ----------------------------------------------------------

  timeoutHandle = setTimeout(() => {
    timedOut = true;
    // Fire-and-forget — `killRender` resolves when the child actually exits,
    // at which point the exit handler below will run and finalize the
    // ActiveRender with `RENDER_TIMEOUT`.
    void killRender(projectId);
  }, TIMEOUTS_MS.HYPERFRAMES_RENDER);

  // --- spawn failure ("error" event) ------------------------------------

  child.on("error", (err) => {
    void logger.error("render_child_error", {
      error: err.message,
    });
    finalizeFailure(active, outputAbs, {
      code: ErrorCode.UNKNOWN,
      message: `spawn error: ${err.message}`.slice(
        0,
        LIMITS.ERROR_MESSAGE_MAX,
      ),
    });
    clearTimers();
  });

  // --- exit -------------------------------------------------------------

  child.on("exit", async (code, signal) => {
    clearTimers();
    childProcesses.delete(projectId);

    if (active.status !== "running") {
      // Already finalized (e.g. spawn "error" beat us to it).
      return;
    }

    // Timeout wins regardless of the exit code.
    if (timedOut) {
      await safeUnlink(outputAbs);
      void logger.warn("render_timeout", {
        timeoutMs: TIMEOUTS_MS.HYPERFRAMES_RENDER,
      });
      finalizeFailure(active, outputAbs, {
        code: ErrorCode.RENDER_TIMEOUT,
        message: `render timed out after ${TIMEOUTS_MS.HYPERFRAMES_RENDER}ms`,
      });
      return;
    }

    // Clean exit — validate the output file before declaring success.
    if (code === 0) {
      let size = 0;
      let exists = false;
      try {
        const s = await stat(outputAbs);
        exists = true;
        size = s.size;
      } catch {
        exists = false;
      }

      if (exists && size > 0) {
        const videoUrl = `${PUBLIC_VIDEO_URL_PREFIX}/project-${projectId}.mp4`;
        void logger.info("render_done", {
          videoUrl,
          bytes: size,
        });
        finalizeSuccess(active, videoUrl);
        return;
      }

      // Exit 0 but missing or zero-byte file → treat as failure per Req 10.9.
      await safeUnlink(outputAbs);
      void logger.error("render_output_invalid", { exists, size });
      finalizeFailure(active, outputAbs, {
        code: ErrorCode.UNKNOWN,
        message:
          "render exited 0 but output is missing or empty",
      });
      return;
    }

    // Non-zero exit — surface the stderr tail for diagnostics per Req 10.10.
    const tail = stderrTail.join("\n").slice(-LINE_MAX_CHARS);
    const signalSuffix = signal ? ` (signal ${signal})` : "";
    await safeUnlink(outputAbs);
    void logger.error("render_exit_nonzero", {
      code,
      signal,
      stderrTail: tail,
    });
    finalizeFailure(active, outputAbs, {
      code: ErrorCode.UNKNOWN,
      message: `render exited ${code ?? "null"}${signalSuffix}: ${tail}`.slice(
        0,
        LIMITS.ERROR_MESSAGE_MAX,
      ),
    });
  });

  return { runId, active };
}

/** Finalize the ActiveRender as done and emit the terminal `stage:done`. */
function finalizeSuccess(active: ActiveRender, videoUrl: string): void {
  if (active.status !== "running") return;
  active.status = "done";
  active.videoPath = videoUrl;
  emitEvent(active, { type: "stage", stage: "done", at: nowIso() });
}

/**
 * Finalize the ActiveRender as failed. `partialOutputAbs` is informational
 * only — the exit handler is responsible for the actual unlink — but we
 * accept it here so the signature matches `finalizeSuccess`.
 */
function finalizeFailure(
  active: ActiveRender,
  _partialOutputAbs: string | null,
  error: { code: string; message: string },
): void {
  if (active.status !== "running") return;
  active.status = "failed";
  active.error = error;
  emitEvent(active, { type: "stage", stage: "failed", at: nowIso() });
}

/** Best-effort unlink; ENOENT and all other errors are swallowed. */
async function safeUnlink(absPath: string): Promise<void> {
  try {
    await unlink(absPath);
  } catch {
    // Nothing to clean up, or permission error — either way there is no
    // productive recovery here.
  }
}

// ---------------------------------------------------------------------------
// getActiveRender / subscribeRender / killRender
// ---------------------------------------------------------------------------

/** Return the in-memory handle for `projectId`, or `undefined`. */
export function getActiveRender(projectId: string): ActiveRender | undefined {
  return activeRenders.get(projectId);
}

/**
 * Async iterable over a render's `RenderEvent` stream. Usage:
 *
 * ```ts
 * for await (const ev of subscribeRender(projectId)) { … }
 * ```
 *
 * Semantics:
 *   - Throws `WorkbenchError(NO_RENDER)` if no render record exists.
 *   - Replays every event already in `active.events` first (catch-up for
 *     late joiners).
 *   - If the render was already terminal when subscribed, the generator
 *     yields the replay and then returns — it does NOT wait for new events.
 *   - Otherwise the generator tails `active.events`, waking up whenever a
 *     new event is emitted, and returns as soon as a `stage: done` or
 *     `stage: failed` event is yielded.
 *
 * _Requirements: 10.7_
 */
export function subscribeRender(
  projectId: string,
): AsyncIterable<RenderEvent> {
  const active = activeRenders.get(projectId);
  if (!active) {
    throw new WorkbenchError(
      ErrorCode.NO_RENDER,
      "No active render for project",
      { projectId },
    );
  }
  return subscribeRenderImpl(active);
}

async function* subscribeRenderImpl(
  active: ActiveRender,
): AsyncIterable<RenderEvent> {
  let nextIndex = 0;

  /**
   * Pending "wake up" promise for the generator. Resolved by the listener
   * below whenever a new event is broadcast. `null` when no wait is in
   * flight (the generator has already drained everything or is yielding).
   */
  let resolveWaiter: (() => void) | null = null;

  const listener = (_ev: RenderEvent): void => {
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  };

  // Register subscriber so `emitEvent` wakes us up on new events.
  let subs = subscribers.get(active.projectId);
  if (!subs) {
    subs = new Set();
    subscribers.set(active.projectId, subs);
  }
  subs.add(listener);

  try {
    while (true) {
      // Drain any events we haven't yielded yet.
      while (nextIndex < active.events.length) {
        const ev = active.events[nextIndex++];
        yield ev;
        if (
          ev.type === "stage" &&
          (ev.stage === "done" || ev.stage === "failed")
        ) {
          return;
        }
      }

      // If the render is already terminal (e.g. we joined late, after the
      // terminal event was appended), exit without waiting.
      if (active.status !== "running") return;

      // Park until a new event arrives or the render finalizes.
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
      });
    }
  } finally {
    // Clean up subscriber registration even on early termination
    // (break/return/throw from the caller's for-await loop).
    const currentSubs = subscribers.get(active.projectId);
    if (currentSubs) {
      currentSubs.delete(listener);
      if (currentSubs.size === 0) {
        subscribers.delete(active.projectId);
      }
    }
  }
}

/**
 * Send SIGTERM to the running child for `projectId`; if it hasn't exited
 * within `KILL_GRACE_MS`, escalate to SIGKILL. Resolves once the child has
 * actually exited (the `exit` handler registered in `startRender` will do
 * the ActiveRender finalization).
 *
 * No-op if no child is tracked for `projectId` — including the case where
 * the child already exited naturally.
 */
export async function killRender(projectId: string): Promise<void> {
  const child = childProcesses.get(projectId);
  if (!child) return;

  // If the child has already exited (exitCode is set), just drop our handle.
  if (child.exitCode !== null || child.signalCode !== null) {
    childProcesses.delete(projectId);
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch (err) {
    console.error("[render-service] SIGTERM failed:", err);
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(sigkillTimer);
      resolve();
    };

    const sigkillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (err) {
        console.error("[render-service] SIGKILL failed:", err);
      }
      // Give the OS a brief moment to reap the process.
      setTimeout(settle, 100);
    }, KILL_GRACE_MS);

    child.once("exit", settle);
  });

  childProcesses.delete(projectId);
}

// ---------------------------------------------------------------------------
// runHyperframesLint / runHyperframesValidate
// ---------------------------------------------------------------------------

/**
 * Run `npx hyperframes lint` inside the project's composition directory.
 * Captures stdout + stderr and returns `{ ok: code === 0, stderr }`. Any
 * timeout or spawn failure is surfaced as `ok: false` with a descriptive
 * stderr string — the caller decides whether to map that to
 * `LINT_FAILED` (502) or a different envelope.
 *
 * _Requirements: 6.5_
 */
export async function runHyperframesLint(
  projectId: string,
): Promise<{ ok: boolean; stderr: string }> {
  const compositionDir = resolveProjectFile(projectId, STAGE_DIRS.COMPOSITION);
  return runHyperframesOneShot(
    compositionDir,
    "lint",
    TIMEOUTS_MS.HYPERFRAMES_LINT,
  );
}

/**
 * Run `npx hyperframes validate` inside the project's composition directory.
 * Same semantics as `runHyperframesLint`; separated so composition repair
 * logic can distinguish between syntax failures (lint) and semantic failures
 * (validate).
 *
 * _Requirements: 6.5_
 */
export async function runHyperframesValidate(
  projectId: string,
): Promise<{ ok: boolean; stderr: string }> {
  const compositionDir = resolveProjectFile(projectId, STAGE_DIRS.COMPOSITION);
  return runHyperframesOneShot(
    compositionDir,
    "validate",
    TIMEOUTS_MS.HYPERFRAMES_VALIDATE,
  );
}

/**
 * Shared scaffold for one-shot `npx hyperframes <cmd>` invocations. Collects
 * stdout + stderr together into the returned `stderr` field (some tools
 * write diagnostic output to stdout), pins to the same CLI version as
 * `startRender`, and hard-caps execution at `timeoutMs`.
 */
async function runHyperframesOneShot(
  cwd: string,
  cmd: "lint" | "validate",
  timeoutMs: number,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const output: Buffer[] = [];

    const finish = (ok: boolean, stderr: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stderr });
    };

    let child: ChildProcess;
    try {
      child = spawn("npx", ["--yes", HYPERFRAMES_CLI, cmd], {
        cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        ok: false,
        stderr: `spawn failed: ${(err as Error)?.message ?? String(err)}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // nothing meaningful to do — we are already aborting
      }
      finish(false, `hyperframes ${cmd} timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));

    child.on("error", (err) => {
      finish(false, err.message);
    });

    child.on("exit", (code) => {
      const combined = Buffer.concat(output).toString("utf8");
      finish(code === 0, combined);
    });
  });
}
