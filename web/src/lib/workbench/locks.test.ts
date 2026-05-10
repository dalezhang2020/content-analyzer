/**
 * Video Creation Workbench — per-project lock property tests (T18.2).
 *
 * Verifies the three guarantees of `withProjectLock` using scheduled
 * interleavings via `fc.scheduler`:
 *
 *   • Property 21a (mutex): concurrent acquirers of the *same*
 *     `projectId` never have their `fn` bodies overlap — the in-flight
 *     counter stays ≤ 1 under every interleaving.
 *   • Property 21b (no cross-blocking): concurrent acquirers of
 *     *different* `projectId`s can freely overlap (they do not serialise
 *     each other).
 *   • Property 21c (fail-fast): a second acquire attempt while a lock is
 *     held throws `LOCK_BUSY` immediately (no queueing, no await).
 *
 * _Validates: Requirements 1.11, 10.3_
 */

import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  isLocked,
  withProjectLock,
} from "./locks";
import { ErrorCode, WorkbenchError, isWorkbenchError } from "./errors";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Valid `projectId`s per `REGEX.PROJECT_ID` in `constants.ts`. */
const PROJECT_A = "proj_1700000000000_aaaaaa";
const PROJECT_B = "proj_1700000000000_bbbbbb";

/** Keep scheduled tests cheap — interleaving space blows up quickly. */
const NUM_RUNS = 20;

/** Sanity: confirm no test leaves a lock slot hanging between cases. */
afterEach(() => {
  expect(isLocked(PROJECT_A)).toBe(false);
  expect(isLocked(PROJECT_B)).toBe(false);
});

/**
 * Swallow a `LOCK_BUSY` rejection so the caller can `Promise.all` a pool
 * of concurrent attempts without needing per-attempt try/catch. Any
 * other error is re-thrown so bugs still surface.
 */
function ignoreLockBusy(e: unknown): undefined {
  if (isWorkbenchError(e) && e.code === ErrorCode.LOCK_BUSY) return undefined;
  throw e;
}

// ---------------------------------------------------------------------------
// Property 21a — mutual exclusion on the same projectId
// ---------------------------------------------------------------------------

describe("withProjectLock — Property 21a (mutex)", () => {
  it("no two fn invocations for the same projectId ever overlap", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 2, max: 5 }),
        async (s, concurrency) => {
          let inFlight = 0;
          let maxInFlight = 0;
          let successCount = 0;

          /**
           * Body of each acquirer. Increments a shared counter on entry
           * and decrements on exit; the scheduler-controlled `yield`
           * gives other queued tasks an opportunity to run in between —
           * which is precisely the window where overlap would show up
           * if the lock were broken.
           */
          const makeFn = (label: string) => async () => {
            inFlight++;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            // Yield control under scheduler control so interleavings
            // between holding the lock and other pending attempts are
            // explored.
            await s.schedule(Promise.resolve(), `inside-${label}`);
            inFlight--;
            successCount++;
          };

          // Fire `concurrency` acquire attempts for the same projectId.
          // Exactly one should succeed at a time; all others raise
          // LOCK_BUSY synchronously (swallowed here).
          const attempts: Promise<unknown>[] = [];
          for (let i = 0; i < concurrency; i++) {
            attempts.push(
              withProjectLock(PROJECT_A, makeFn(String(i))).catch(
                ignoreLockBusy,
              ),
            );
          }

          await s.waitAll();
          await Promise.all(attempts);

          // Mutex invariant: counter never exceeded 1 under any
          // interleaving the scheduler produced.
          expect(maxInFlight).toBeLessThanOrEqual(1);
          // At least one holder must have actually executed, otherwise
          // this run is vacuous.
          expect(successCount).toBeGreaterThanOrEqual(1);
          // Lock slot must be released on the way out.
          expect(isLocked(PROJECT_A)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("after the holder releases, the next acquire succeeds", async () => {
    // Sequential re-acquire after release must work — no stale lock.
    let runs = 0;
    await withProjectLock(PROJECT_A, async () => {
      runs++;
    });
    await withProjectLock(PROJECT_A, async () => {
      runs++;
    });
    expect(runs).toBe(2);
    expect(isLocked(PROJECT_A)).toBe(false);
  });

  it("fn rejection still releases the lock", async () => {
    await expect(
      withProjectLock(PROJECT_A, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(isLocked(PROJECT_A)).toBe(false);

    // The slot must be free for the next acquirer.
    await expect(
      withProjectLock(PROJECT_A, async () => "ok"),
    ).resolves.toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Property 21b — no cross-blocking between distinct projectIds
// ---------------------------------------------------------------------------

describe("withProjectLock — Property 21b (no cross-blocking)", () => {
  it("fn invocations for different projectIds can overlap freely", async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async (s) => {
        let inFlightA = 0;
        let inFlightB = 0;
        let maxInFlightA = 0;
        let maxInFlightB = 0;
        let overlapObserved = false;

        const fnFor = (which: "A" | "B") => async () => {
          if (which === "A") {
            inFlightA++;
            if (inFlightA > maxInFlightA) maxInFlightA = inFlightA;
          } else {
            inFlightB++;
            if (inFlightB > maxInFlightB) maxInFlightB = inFlightB;
          }
          // If the other project's fn is also running, we've witnessed
          // legal concurrency across different projectIds.
          if (inFlightA > 0 && inFlightB > 0) overlapObserved = true;

          await s.schedule(Promise.resolve(), `inside-${which}`);

          // Re-check after yielding — the window inside the scheduler
          // is the most likely place to observe overlap.
          if (inFlightA > 0 && inFlightB > 0) overlapObserved = true;

          if (which === "A") inFlightA--;
          else inFlightB--;
        };

        const aTask = withProjectLock(PROJECT_A, fnFor("A"));
        const bTask = withProjectLock(PROJECT_B, fnFor("B"));

        await s.waitAll();
        await Promise.all([aTask, bTask]);

        // Per-project mutex still holds.
        expect(maxInFlightA).toBeLessThanOrEqual(1);
        expect(maxInFlightB).toBeLessThanOrEqual(1);
        // Both must have completed (no spurious LOCK_BUSY across
        // projects).
        expect(inFlightA).toBe(0);
        expect(inFlightB).toBe(0);
        // With a fair scheduler exploring interleavings, at least one
        // run should witness concurrent holders across projects.
        // (We keep this as a global witness asserted after the full
        //  property below — see the separate `expect` there.)
        return overlapObserved;
      }),
      {
        numRuns: NUM_RUNS,
        // At least one run across the fast-check sample must actually
        // observe overlap; otherwise the property provides no evidence
        // the lock is non-cross-blocking.
        // We express this through an `examples` witness below.
      },
    );
  });

  it("at least one scheduler interleaving actually exhibits cross-project overlap", async () => {
    // Deterministic witness using a scheduler that we drain in a way
    // that guarantees A and B interleave: start both, then release
    // scheduled tasks one-by-one.
    let inFlightA = 0;
    let inFlightB = 0;
    let overlapSeen = false;

    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async (s) => {
        const fnA = async () => {
          inFlightA++;
          await s.schedule(Promise.resolve(), "A-inner");
          if (inFlightA > 0 && inFlightB > 0) overlapSeen = true;
          inFlightA--;
        };
        const fnB = async () => {
          inFlightB++;
          await s.schedule(Promise.resolve(), "B-inner");
          if (inFlightA > 0 && inFlightB > 0) overlapSeen = true;
          inFlightB--;
        };

        const aTask = withProjectLock(PROJECT_A, fnA);
        const bTask = withProjectLock(PROJECT_B, fnB);

        await s.waitAll();
        await Promise.all([aTask, bTask]);
      }),
      { numRuns: NUM_RUNS },
    );

    expect(overlapSeen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 21c — busy lock fails fast with LOCK_BUSY (no queueing)
// ---------------------------------------------------------------------------

describe("withProjectLock — Property 21c (fail-fast)", () => {
  it("a second acquire on a busy lock throws LOCK_BUSY immediately", async () => {
    // Hold the lock with an fn that we control via an external promise.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = withProjectLock(PROJECT_A, async () => {
      await gate;
      return "held";
    });

    // Give the microtask queue a tick so the lock is visibly held.
    await Promise.resolve();
    expect(isLocked(PROJECT_A)).toBe(true);

    // Second attempt must reject synchronously (before any await of
    // the inner fn, which must never run).
    let innerRan = false;
    await expect(
      withProjectLock(PROJECT_A, async () => {
        innerRan = true;
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.LOCK_BUSY,
    });
    expect(innerRan).toBe(false);

    // Cleanup: release the holder and make sure it actually completes.
    release();
    await expect(holder).resolves.toBe("held");
    expect(isLocked(PROJECT_A)).toBe(false);
  });

  it("LOCK_BUSY is a WorkbenchError carrying the projectId in details", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = withProjectLock(PROJECT_A, async () => {
      await gate;
    });

    await Promise.resolve();

    try {
      await withProjectLock(PROJECT_A, async () => {
        /* never runs */
      });
      throw new Error("expected LOCK_BUSY to be thrown");
    } catch (e) {
      expect(isWorkbenchError(e)).toBe(true);
      const err = e as WorkbenchError;
      expect(err.code).toBe(ErrorCode.LOCK_BUSY);
      expect(err.details).toMatchObject({ projectId: PROJECT_A });
    }

    release();
    await holder;
  });

  it("different projectIds never block each other (fail-fast only applies per key)", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const aTask = withProjectLock(PROJECT_A, async () => {
      await gateA;
      return "A";
    });

    await Promise.resolve();
    expect(isLocked(PROJECT_A)).toBe(true);
    expect(isLocked(PROJECT_B)).toBe(false);

    // While A is held, B acquires and completes immediately.
    await expect(
      withProjectLock(PROJECT_B, async () => "B"),
    ).resolves.toBe("B");

    releaseA();
    await expect(aTask).resolves.toBe("A");
  });
});
