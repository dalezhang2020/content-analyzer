/**
 * Property-based tests for the workbench state machine.
 *
 * Covers tasks T09.2 – T09.6:
 *   - Property 1  — transition table well-formedness
 *   - Property 2  — regression resets downstream stages only
 *   - Property 3  — stage transition is atomic (pure, non-mutating)
 *   - Property 4  — per-stage lifecycle preserves stage + orders timestamps
 *   - Property 26 — three-consecutive-failures hint trigger
 *
 * Validates: Requirements 1.3–1.10, 14.8.
 *
 * These tests use the shared `fc.configureGlobal` seed from `src/test/setup.ts`
 * so any failure is reproducible without extra flags.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { STAGES, STAGE_ORDER } from "@/lib/workbench/constants";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import {
  ALL_TRANSITIONS,
  BACKWARD_TRANSITIONS,
  FORWARD_TRANSITIONS,
  allowedNextStages,
  applyTransition,
  assertCanTransition,
  canTransition,
  initialStageStatusMap,
  markStageFailed,
  markStageRunning,
  markStageSucceeded,
  shouldSuggestRegress,
} from "@/lib/workbench/state-machine";
import type {
  Project,
  Stage,
  StageHistoryEntry,
  StageStatus,
  StageStatusMap,
  StageStatusValue,
} from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STAGE_STATUS_VALUES: readonly StageStatusValue[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
];

const stageArb: fc.Arbitrary<Stage> = fc.constantFrom(...STAGES);

const stageStatusValueArb: fc.Arbitrary<StageStatusValue> = fc.constantFrom(
  ...STAGE_STATUS_VALUES,
);

/**
 * Arbitrary `StageStatus` with optional timestamps, attempts, and error — so
 * we exercise the "regression wipes even a populated status" case in
 * Property 2.
 */
const stageStatusArb: fc.Arbitrary<StageStatus> = fc.record(
  {
    status: stageStatusValueArb,
    startedAt: fc.option(fc.date().map((d) => d.toISOString()), { nil: undefined }),
    finishedAt: fc.option(fc.date().map((d) => d.toISOString()), { nil: undefined }),
    attempts: fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
    error: fc.option(
      fc.record({
        code: fc.string({ minLength: 1, maxLength: 20 }),
        message: fc.string({ minLength: 0, maxLength: 50 }),
      }),
      { nil: undefined },
    ),
  },
  { requiredKeys: ["status"] },
);

const stageStatusMapArb: fc.Arbitrary<StageStatusMap> = fc
  .tuple(
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
  )
  .map(([topic, brief, storyboard, composition, audio, render, qa, published]) => ({
    topic,
    brief,
    storyboard,
    composition,
    audio,
    render,
    qa,
    published,
  }));

/** Minimal valid Project shell. Fields outside the state machine's concern are constant. */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1,
    projectId: "proj_1700000000000_abc123",
    title: "Test Project",
    topic: "Test topic",
    locale: "zh-CN",
    stage: "topic",
    stageStatus: initialStageStatusMap(),
    stageHistory: [],
    brief: null,
    storyboard: null,
    artifacts: {
      briefPath: null,
      storyboardPath: null,
      compositionDir: null,
      indexHtmlPath: null,
      hyperframesJsonPath: null,
      audioPaths: [],
      videoPath: null,
    },
    qaNotes: [],
    templateSource: {
      name: "linear-launch",
      version: "0.0.0-test",
      sourcePath: "/irrelevant",
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Project at an arbitrary stage with an arbitrary (possibly populated) stageStatus. */
const projectArb: fc.Arbitrary<Project> = fc
  .record({
    stage: stageArb,
    stageStatus: stageStatusMapArb,
  })
  .map(({ stage, stageStatus }) => makeProject({ stage, stageStatus }));

/** Pair (from, to) drawn from the full Stage × Stage grid — most will be illegal. */
const anyStagePairArb: fc.Arbitrary<{ from: Stage; to: Stage }> = fc.record({
  from: stageArb,
  to: stageArb,
});

/** Legal regression target from "qa". */
const regressionTargetArb: fc.Arbitrary<Stage> = fc.constantFrom(
  "storyboard",
  "composition",
  "audio",
);

/** Legal (from, to) drawn from the transition table. */
const legalTransitionArb: fc.Arbitrary<{ from: Stage; to: Stage }> = fc
  .constantFrom(...ALL_TRANSITIONS)
  .map((t) => ({ from: t.from, to: t.to }));

// ---------------------------------------------------------------------------
// Property 1 — State transition table is well-formed (T09.2)
// Validates: Requirements 1.3, 1.5
// ---------------------------------------------------------------------------

describe("Property 1: state transition table is well-formed", () => {
  /** Ground-truth membership check against the union of the two tables. */
  function isMember(from: Stage, to: Stage): boolean {
    for (const edge of FORWARD_TRANSITIONS) {
      if (edge.from === from && edge.to === to) return true;
    }
    for (const edge of BACKWARD_TRANSITIONS) {
      if (edge.from === from && edge.to === to) return true;
    }
    return false;
  }

  it("canTransition(from, to) iff (from, to) ∈ FORWARD ∪ BACKWARD", () => {
    fc.assert(
      fc.property(anyStagePairArb, ({ from, to }) => {
        expect(canTransition(from, to)).toBe(isMember(from, to));
      }),
    );
  });

  it("allowedNextStages(from) equals the set of legal successors", () => {
    fc.assert(
      fc.property(stageArb, (from) => {
        const actual = new Set(allowedNextStages(from));
        const expected = new Set(
          STAGES.filter((to) => isMember(from, to)),
        );
        expect(actual).toEqual(expected);
      }),
    );
  });

  it("assertCanTransition throws INVALID_TRANSITION iff the edge is illegal", () => {
    fc.assert(
      fc.property(anyStagePairArb, ({ from, to }) => {
        if (isMember(from, to)) {
          expect(() => assertCanTransition(from, to)).not.toThrow();
          return;
        }
        let caught: unknown;
        try {
          assertCanTransition(from, to);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(WorkbenchError);
        expect((caught as WorkbenchError).code).toBe(ErrorCode.INVALID_TRANSITION);
        // Details echo the current/requested pair and the allowed successors.
        const details = (caught as WorkbenchError).details ?? {};
        expect(details.currentStage).toBe(from);
        expect(details.requestedStage).toBe(to);
        expect(Array.isArray(details.allowedNextStages)).toBe(true);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — Regression resets downstream stages only (T09.3)
// Validates: Requirement 1.4
// ---------------------------------------------------------------------------

describe("Property 2: regression resets downstream stages only", () => {
  it("qa → {storyboard|composition|audio}: target + downstream become pending, upstream is preserved", () => {
    fc.assert(
      fc.property(
        stageStatusMapArb,
        regressionTargetArb,
        fc.string({ minLength: 0, maxLength: 40 }),
        (stageStatus, target, reason) => {
          const project = makeProject({ stage: "qa", stageStatus });
          const next = applyTransition(project, target, { reason });

          const threshold = STAGE_ORDER[target];
          for (const stage of STAGES) {
            if (STAGE_ORDER[stage] >= threshold) {
              // Target and every downstream stage reset to pure pending.
              expect(next.stageStatus[stage]).toEqual({ status: "pending" });
            } else {
              // Upstream stages unchanged (deep equal — same content).
              expect(next.stageStatus[stage]).toEqual(stageStatus[stage]);
            }
          }

          expect(next.stage).toBe(target);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3 — Stage transition is atomic (T09.4)
// Validates: Requirement 1.6
// ---------------------------------------------------------------------------

describe("Property 3: applyTransition is pure and does not mutate its input", () => {
  it("returns a new Project object; stage/stageStatus/stageHistory/updatedAt of input unchanged", () => {
    fc.assert(
      fc.property(
        legalTransitionArb,
        stageStatusMapArb,
        fc.string({ minLength: 0, maxLength: 20 }),
        ({ from, to }, stageStatus, reason) => {
          const project = makeProject({ stage: from, stageStatus });
          // Deep-snapshot the four fields the property cares about.
          const snapshot = {
            stage: project.stage,
            stageStatus: structuredClone(project.stageStatus),
            stageHistory: structuredClone(project.stageHistory),
            updatedAt: project.updatedAt,
          };

          const next = applyTransition(project, to, { reason });

          // A new object, not the same reference.
          expect(next).not.toBe(project);

          // Every field we snapshotted on the ORIGINAL is untouched.
          expect(project.stage).toBe(snapshot.stage);
          expect(project.stageStatus).toEqual(snapshot.stageStatus);
          expect(project.stageHistory).toEqual(snapshot.stageHistory);
          expect(project.updatedAt).toBe(snapshot.updatedAt);

          // Sanity: the new object actually advanced to `to`.
          expect(next.stage).toBe(to);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — Per-stage status lifecycle preserves stage + orders timestamps (T09.5)
// Validates: Requirements 1.8, 1.9, 1.10
// ---------------------------------------------------------------------------

describe("Property 4: per-stage status lifecycle", () => {
  /** Strictly increasing ISO timestamps so startedAt ≤ finishedAt is meaningful. */
  const timestampSeqArb = fc
    .array(fc.integer({ min: 1, max: 10_000 }), { minLength: 2, maxLength: 40 })
    .map((steps) => {
      let t = Date.UTC(2024, 0, 1);
      const out: string[] = [];
      for (const step of steps) {
        t += step;
        out.push(new Date(t).toISOString());
      }
      return out;
    });

  /** Non-empty list of run-cycles, each ending in success or failure. */
  const cyclesArb = fc.array(
    fc.record({
      terminal: fc.constantFrom<"succeeded" | "failed">("succeeded", "failed"),
    }),
    { minLength: 1, maxLength: 10 },
  );

  it("stage field stays constant, startedAt ≤ finishedAt, attempts monotonically increments", () => {
    fc.assert(
      fc.property(
        stageArb, // the project's current stage (kept constant by the helpers)
        stageArb, // the stage we mutate
        cyclesArb,
        timestampSeqArb,
        (projectStage, targetStage, cycles, timestamps) => {
          // We need 2 timestamps per cycle (start + end). Precondition to
          // avoid wasting runs on malformed inputs.
          fc.pre(timestamps.length >= cycles.length * 2);

          let project = makeProject({ stage: projectStage });
          let prevAttempts = project.stageStatus[targetStage].attempts ?? 0;
          let tsIdx = 0;

          for (const cycle of cycles) {
            const startedAt = timestamps[tsIdx++];
            const finishedAt = timestamps[tsIdx++];

            // markStageRunning: stage field preserved, attempts increments by 1.
            project = markStageRunning(project, targetStage, startedAt);
            expect(project.stage).toBe(projectStage);
            const running = project.stageStatus[targetStage];
            expect(running.status).toBe("running");
            expect(running.startedAt).toBe(startedAt);
            expect(running.attempts).toBe(prevAttempts + 1);
            prevAttempts = running.attempts ?? prevAttempts + 1;

            // Terminal transition: stage field preserved, timestamps ordered.
            if (cycle.terminal === "succeeded") {
              project = markStageSucceeded(project, targetStage, finishedAt);
            } else {
              project = markStageFailed(
                project,
                targetStage,
                { code: "X", message: "boom" },
                finishedAt,
              );
            }
            expect(project.stage).toBe(projectStage);

            const terminal = project.stageStatus[targetStage];
            expect(terminal.status).toBe(cycle.terminal);
            // Both timestamps should be present on a terminal entry.
            expect(terminal.startedAt).toBeDefined();
            expect(terminal.finishedAt).toBeDefined();
            // And properly ordered.
            expect(
              new Date(terminal.startedAt as string).getTime(),
            ).toBeLessThanOrEqual(
              new Date(terminal.finishedAt as string).getTime(),
            );
            // attempts is carried through from the running cycle.
            expect(terminal.attempts).toBe(prevAttempts);
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 26 — Three-consecutive-failures hint trigger (T09.6)
// Validates: Requirement 14.8
// ---------------------------------------------------------------------------

describe("Property 26: shouldSuggestRegress", () => {
  /** Arbitrary `StageHistoryEntry` with a given toStage and result. */
  function entry(toStage: Stage, result: "success" | "failure"): StageHistoryEntry {
    return {
      fromStage: "topic",
      toStage,
      at: "2024-01-01T00:00:00.000Z",
      result,
    };
  }

  const historyEntryArb: fc.Arbitrary<StageHistoryEntry> = fc.record({
    fromStage: stageArb,
    toStage: stageArb,
    at: fc.date().map((d) => d.toISOString()),
    result: fc.constantFrom<"success" | "failure">("success", "failure"),
  });

  it("matches the spec: last 3 entries for `stage` all failure → true; else false", () => {
    fc.assert(
      fc.property(
        fc.array(historyEntryArb, { minLength: 0, maxLength: 30 }),
        stageArb,
        (history, stage) => {
          // Ground-truth computation mirroring the spec wording.
          const related = history.filter((e) => e.toStage === stage);
          const expected =
            related.length >= 3 &&
            related.slice(-3).every((e) => e.result === "failure");

          expect(shouldSuggestRegress(history, stage)).toBe(expected);
        },
      ),
    );
  });

  it("returns false for histories with fewer than 3 entries targeting the stage", () => {
    fc.assert(
      fc.property(
        // Build a history containing 0–2 failing entries on `stage` plus
        // arbitrary unrelated entries on other stages.
        fc.record({
          stage: stageArb,
          failCount: fc.integer({ min: 0, max: 2 }),
          noise: fc.array(historyEntryArb, { minLength: 0, maxLength: 20 }),
        }),
        ({ stage, failCount, noise }) => {
          const otherStages = STAGES.filter((s) => s !== stage);
          const noiseOnOthers = noise.map((e) => ({
            ...e,
            toStage:
              e.toStage === stage
                ? (otherStages[0] as Stage)
                : e.toStage,
          }));
          const failures: StageHistoryEntry[] = Array.from(
            { length: failCount },
            () => entry(stage, "failure"),
          );
          const history = [...noiseOnOthers, ...failures];

          expect(shouldSuggestRegress(history, stage)).toBe(false);
        },
      ),
    );
  });

  it("returns true for a history whose last three `stage`-entries are all failures, regardless of interleaved noise", () => {
    fc.assert(
      fc.property(
        stageArb,
        fc.array(historyEntryArb, { minLength: 0, maxLength: 15 }),
        (stage, prefix) => {
          // Rewrite any `stage`-targeting prefix entry to point elsewhere so
          // our trailing three failures are guaranteed to be the "last three".
          const otherStages = STAGES.filter((s) => s !== stage);
          const safePrefix = prefix.map((e) =>
            e.toStage === stage
              ? { ...e, toStage: otherStages[0] as Stage }
              : e,
          );
          const history: StageHistoryEntry[] = [
            ...safePrefix,
            entry(stage, "failure"),
            entry(stage, "failure"),
            entry(stage, "failure"),
          ];

          expect(shouldSuggestRegress(history, stage)).toBe(true);
        },
      ),
    );
  });
});
