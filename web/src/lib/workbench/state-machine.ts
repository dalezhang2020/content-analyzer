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
 * Forward progression `brief → storyboard → composition → audio → render`.
 * Every edge is a single-step advance; there is no "skip" transition.
 *
 * Simplified from original 8-stage DAG: topic/qa/published removed.
 */
export const FORWARD_TRANSITIONS: readonly StageTransition[] = [
  { from: "brief", to: "storyboard" },
  { from: "storyboard", to: "composition" },
  { from: "composition", to: "audio" },
  { from: "audio", to: "render" },
] as const;

/**
 * No automatic regression edges in the simplified workflow. Use
 * `regressToStage` for manual jumps backward.
 */
export const BACKWARD_TRANSITIONS: readonly StageTransition[] = [] as const;

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

  // Forward-only automatic transitions. Manual regressions use
  // `regressToStage` which resets downstream stageStatus explicitly.
  return {
    ...project,
    stage: to,
    stageStatus: project.stageStatus,
    stageHistory: [...project.stageHistory, historyEntry],
    updatedAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// Manual regression (universal backward jump)
// ---------------------------------------------------------------------------

/** Options accepted by `regressToStage`. */
export interface RegressToStageOptions {
  /** Human-readable reason; truncated to `LIMITS.REASON_MAX`. */
  reason?: string;
  /** ISO 8601 UTC timestamp. Defaults to `new Date().toISOString()`. */
  now?: string;
}

/**
 * Regress the project's stage to an earlier `target`. Unlike the strict
 * `applyTransition` edges (which only permit the narrow `qa → {...}` set),
 * this helper accepts any pair where
 * `STAGE_ORDER[target] < STAGE_ORDER[project.stage]`.
 *
 * Semantics:
 *   - `stage` resets to `target`.
 *   - Every stage with `STAGE_ORDER >= STAGE_ORDER[target]` has its
 *     status reset to `{ status: "pending" }` via `resetDownstreamStatus`.
 *   - A `{ fromStage, toStage: target, at: now, reason, result: "success" }`
 *     entry is appended to `stageHistory`.
 *   - `updatedAt` is refreshed to `now`.
 *
 * This is the explicit "manual override" path intended to unblock users
 * when the automatic pipeline's narrow regression edges aren't enough
 * (e.g. regressing from `published` back to `composition`). The strict
 * `FORWARD_TRANSITIONS` / `BACKWARD_TRANSITIONS` guards remain in place
 * for the automatic pipeline — do not conflate the two.
 *
 * Throws `WorkbenchError(INVALID_TRANSITION, …)` when `target` is not
 * strictly earlier than the current stage (no sideways, no forward).
 * The input project is **not** mutated.
 */
export function regressToStage(
  project: Project,
  target: Stage,
  opts: RegressToStageOptions = {},
): Project {
  const currentOrder = STAGE_ORDER[project.stage];
  const targetOrder = STAGE_ORDER[target];

  if (!(targetOrder < currentOrder)) {
    throw new WorkbenchError(
      ErrorCode.INVALID_TRANSITION,
      `Cannot regress from "${project.stage}" to "${target}": target must be strictly earlier`,
      {
        currentStage: project.stage,
        requestedStage: target,
      },
    );
  }

  const nowIso = opts.now ?? new Date().toISOString();
  const reason =
    opts.reason === undefined ? undefined : truncate(opts.reason, LIMITS.REASON_MAX);

  const historyEntry: StageHistoryEntry = {
    fromStage: project.stage,
    toStage: target,
    at: nowIso,
    result: "success",
    ...(reason !== undefined ? { reason } : {}),
  };

  return {
    ...project,
    stage: target,
    stageStatus: resetDownstreamStatus(project.stageStatus, target),
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
