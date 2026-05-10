/**
 * Video Creation Workbench — state machine and stage-status lifecycle.
 *
 * This module is the **authoritative** source for every legal stage
 * transition and every stage-status lifecycle mutation. It is pure —
 * nothing here reads from disk, calls the clock beyond the caller's
 * injected `now`, or mutates its inputs. Every operation returns a
 * fresh `Project` or `StageStatusMap`.
 *
 * See design §State Machine and §Regression semantics. Referenced
 * correctness properties: 1 (transition table well-formedness), 2
 * (regression resets downstream only), 3 (transition atomicity), 4
 * (per-stage lifecycle ordering), 26 (three-failure hint).
 */

import { LIMITS, STAGE_ORDER, STAGES } from "./constants";
import { ErrorCode, WorkbenchError } from "./errors";
import type {
  Project,
  Stage,
  StageHistoryEntry,
  StageStatus,
  StageStatusMap,
} from "./types";

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/** One edge in the stage DAG. */
export interface StageTransition {
  readonly from: Stage;
  readonly to: Stage;
}

/**
 * Forward progression `topic → brief → … → qa → published`. Every edge is
 * a single-step advance; there is no "skip" transition.
 *
 * _Requirements: 1.3, 1.5_
 */
export const FORWARD_TRANSITIONS: readonly StageTransition[] = [
  { from: "topic", to: "brief" },
  { from: "brief", to: "storyboard" },
  { from: "storyboard", to: "composition" },
  { from: "composition", to: "audio" },
  { from: "audio", to: "render" },
  { from: "render", to: "qa" },
  { from: "qa", to: "published" },
] as const;

/**
 * Regression edges. Only `qa` may regress, and only to `storyboard`,
 * `composition`, or `audio`. `published` is terminal.
 *
 * _Requirements: 1.4, 1.5_
 */
export const BACKWARD_TRANSITIONS: readonly StageTransition[] = [
  { from: "qa", to: "storyboard" },
  { from: "qa", to: "composition" },
  { from: "qa", to: "audio" },
] as const;

/** Concatenation of forward + backward edges. Stable order. */
export const ALL_TRANSITIONS: readonly StageTransition[] = [
  ...FORWARD_TRANSITIONS,
  ...BACKWARD_TRANSITIONS,
];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Return `true` iff `(from, to)` appears in the union of forward and
 * backward transitions.
 *
 * _Requirements: 1.3, 1.5; Property 1_
 */
export function canTransition(from: Stage, to: Stage): boolean {
  for (const edge of ALL_TRANSITIONS) {
    if (edge.from === from && edge.to === to) return true;
  }
  return false;
}

/**
 * Enumerate every `to` stage for which `canTransition(from, to)` holds.
 * Order matches `ALL_TRANSITIONS`.
 *
 * _Requirements: 1.3, 1.5; Property 1_
 */
export function allowedNextStages(from: Stage): Stage[] {
  const out: Stage[] = [];
  for (const edge of ALL_TRANSITIONS) {
    if (edge.from === from) out.push(edge.to);
  }
  return out;
}

/**
 * Throws `WorkbenchError(INVALID_TRANSITION, …)` when `(from, to)` is not
 * a legal edge. Details include the current stage, the requested stage,
 * and the list of legal next stages — enough for the UI to render a
 * 409 response without a second round-trip.
 *
 * _Requirements: 1.3, 1.5, 14.1_
 */
export function assertCanTransition(
  from: Stage,
  to: Stage,
): asserts to is Stage {
  if (!canTransition(from, to)) {
    throw new WorkbenchError(
      ErrorCode.INVALID_TRANSITION,
      `Cannot transition from "${from}" to "${to}"`,
      {
        currentStage: from,
        requestedStage: to,
        allowedNextStages: allowedNextStages(from),
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Stage-status helpers
// ---------------------------------------------------------------------------

/**
 * Fresh `StageStatusMap` with every stage set to `{ status: "pending" }`.
 * Used at project-creation time.
 *
 * _Requirements: 1.8_
 */
export function initialStageStatusMap(): StageStatusMap {
  const map = {} as StageStatusMap;
  for (const stage of STAGES) {
    map[stage] = { status: "pending" };
  }
  return map;
}

/**
 * Return a new map where every stage with `STAGE_ORDER >= STAGE_ORDER[target]`
 * is reset to `{ status: "pending" }` (no `error`, no timestamps, no
 * `attempts`). Upstream stages are carried over by reference.
 *
 * This implements the regression-reset rule from design §Regression
 * semantics and Property 2.
 *
 * _Requirements: 1.4; Property 2_
 */
export function resetDownstreamStatus(
  map: StageStatusMap,
  target: Stage,
): StageStatusMap {
  const threshold = STAGE_ORDER[target];
  const next = {} as StageStatusMap;
  for (const stage of STAGES) {
    if (STAGE_ORDER[stage] >= threshold) {
      next[stage] = { status: "pending" };
    } else {
      next[stage] = map[stage];
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Transition application
// ---------------------------------------------------------------------------

/** Options accepted by `applyTransition`. */
export interface ApplyTransitionOptions {
  /** Human-readable reason; truncated to `LIMITS.REASON_MAX`. */
  reason?: string;
  /** History `result`. Defaults to `"success"`. */
  result?: "success" | "failure";
  /** ISO 8601 UTC timestamp. Defaults to `new Date().toISOString()`. */
  now?: string;
}

/**
 * Append a transition to the project's history and advance `stage`.
 *
 * Forward edge — `stageStatus` is untouched (Property 3). Backward edge
 * — `stageStatus` for `to` and every downstream stage is reset via
 * `resetDownstreamStatus` (Property 2). `updatedAt` is always refreshed.
 *
 * The input project is **not** mutated; a new object is returned.
 *
 * _Requirements: 1.3–1.6; Properties 2, 3_
 */
export function applyTransition(
  project: Project,
  to: Stage,
  opts: ApplyTransitionOptions = {},
): Project {
  assertCanTransition(project.stage, to);

  const nowIso = opts.now ?? new Date().toISOString();
  const result = opts.result ?? "success";
  const reason =
    opts.reason === undefined ? undefined : truncate(opts.reason, LIMITS.REASON_MAX);

  const historyEntry: StageHistoryEntry = {
    fromStage: project.stage,
    toStage: to,
    at: nowIso,
    result,
    ...(reason !== undefined ? { reason } : {}),
  };

  const isBackward =
    project.stage === "qa" &&
    (to === "storyboard" || to === "composition" || to === "audio");

  const nextStageStatus = isBackward
    ? resetDownstreamStatus(project.stageStatus, to)
    : project.stageStatus;

  return {
    ...project,
    stage: to,
    stageStatus: nextStageStatus,
    stageHistory: [...project.stageHistory, historyEntry],
    updatedAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// Per-stage lifecycle mutators
// ---------------------------------------------------------------------------

/**
 * Enter the `running` state for `stage`: records `startedAt`, bumps
 * `attempts`, and clears any prior `error`. Project-level `stage` is
 * unchanged.
 *
 * _Requirements: 1.8–1.10; Property 4_
 */
export function markStageRunning(
  project: Project,
  stage: Stage,
  now?: string,
): Project {
  const nowIso = now ?? new Date().toISOString();
  const prev = project.stageStatus[stage];
  const nextStatus: StageStatus = {
    status: "running",
    startedAt: nowIso,
    attempts: (prev.attempts ?? 0) + 1,
  };

  return {
    ...project,
    stageStatus: { ...project.stageStatus, [stage]: nextStatus },
    updatedAt: nowIso,
  };
}

/**
 * Enter the `succeeded` state for `stage`: records `finishedAt` and
 * clears any prior `error`. Preserves `startedAt` and `attempts`.
 *
 * _Requirements: 1.8–1.10; Property 4_
 */
export function markStageSucceeded(
  project: Project,
  stage: Stage,
  now?: string,
): Project {
  const nowIso = now ?? new Date().toISOString();
  const prev = project.stageStatus[stage];
  const nextStatus: StageStatus = {
    status: "succeeded",
    ...(prev.startedAt !== undefined ? { startedAt: prev.startedAt } : {}),
    finishedAt: nowIso,
    ...(prev.attempts !== undefined ? { attempts: prev.attempts } : {}),
  };

  return {
    ...project,
    stageStatus: { ...project.stageStatus, [stage]: nextStatus },
    updatedAt: nowIso,
  };
}

/**
 * Enter the `failed` state for `stage`. `error.code` is truncated to
 * `LIMITS.ERROR_CODE_MAX`; `error.message` to `LIMITS.ERROR_MESSAGE_MAX`
 * — matching the convention in `errors.ts`. Project-level `stage` is
 * unchanged (Property 4c).
 *
 * _Requirements: 1.8–1.10, 14.1, 14.7; Property 4_
 */
export function markStageFailed(
  project: Project,
  stage: Stage,
  error: { code: string; message: string },
  now?: string,
): Project {
  const nowIso = now ?? new Date().toISOString();
  const prev = project.stageStatus[stage];
  const nextStatus: StageStatus = {
    status: "failed",
    ...(prev.startedAt !== undefined ? { startedAt: prev.startedAt } : {}),
    finishedAt: nowIso,
    ...(prev.attempts !== undefined ? { attempts: prev.attempts } : {}),
    error: {
      code: error.code.slice(0, LIMITS.ERROR_CODE_MAX),
      message: truncate(error.message, LIMITS.ERROR_MESSAGE_MAX),
    },
  };

  return {
    ...project,
    stageStatus: { ...project.stageStatus, [stage]: nextStatus },
    updatedAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// Failure heuristic
// ---------------------------------------------------------------------------

/**
 * Return `true` iff the last `CONSECUTIVE_FAILURE_THRESHOLD` entries in
 * `history` whose `toStage === stage` all have `result === "failure"`.
 * Never triggers on an empty history or one shorter than the threshold
 * (per Property 26).
 *
 * _Requirements: 14.8; Property 26_
 */
export function shouldSuggestRegress(
  history: readonly StageHistoryEntry[],
  stage: Stage,
): boolean {
  const threshold = LIMITS.CONSECUTIVE_FAILURE_THRESHOLD;
  const related: StageHistoryEntry[] = [];
  for (const entry of history) {
    if (entry.toStage === stage) related.push(entry);
  }
  if (related.length < threshold) return false;
  const tail = related.slice(related.length - threshold);
  return tail.every((e) => e.result === "failure");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Truncate `s` to `max` chars, appending `…` when a cut is made so the
 * result is exactly `max` chars long. Mirrors the convention used by
 * `errors.ts::truncateMessage` so every user-visible string obeys the
 * same rule.
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
