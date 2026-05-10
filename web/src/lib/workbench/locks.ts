/**
 * Video Creation Workbench — per-project in-memory mutex.
 *
 * Serialises mutating operations (`POST`/`PATCH`/`DELETE` under
 * `/api/projects/{id}/**`) plus the render subprocess lifecycle against a
 * single `projectId`. Different `projectId`s use independent slots and
 * never block each other.
 *
 * Policy is **fail-fast**: when the lock is held, `withProjectLock` throws
 * `WorkbenchError(LOCK_BUSY)` immediately instead of queueing. Route
 * handlers surface this as HTTP 409, matching design §Concurrency Model
 * and Req 1.11 / 10.3.
 *
 * _Requirements: 1.11, 10.3; design §Concurrency Model (Property 21)_
 */

import { ErrorCode, WorkbenchError } from "./errors";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * Active lock slots keyed by `projectId`. A key is present for exactly as
 * long as an `fn()` body is in flight for that project. The stored value
 * is the in-flight promise — kept for future introspection/debugging, but
 * never awaited by `withProjectLock` itself (callers see `LOCK_BUSY`).
 */
const locks = new Map<string, Promise<unknown>>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `fn` under an exclusive per-`projectId` lock.
 *
 * - If no lock is currently held for `projectId`, the call registers an
 *   in-flight promise, awaits `fn()`, and releases the slot on settle
 *   (success _or_ failure).
 * - If a lock is already held, this function throws
 *   `WorkbenchError(LOCK_BUSY, …)` synchronously from the caller's
 *   perspective (it never waits for the existing holder to finish).
 *
 * Errors thrown by `fn` propagate to the caller after the slot is
 * released, so a failed operation never leaves the lock stuck.
 *
 * _Requirements: 1.11, 10.3_
 */
export async function withProjectLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (locks.has(projectId)) {
    throw new WorkbenchError(
      ErrorCode.LOCK_BUSY,
      "Project is busy",
      { projectId },
    );
  }

  const promise = (async () => {
    try {
      return await fn();
    } finally {
      locks.delete(projectId);
    }
  })();

  locks.set(projectId, promise);
  return promise;
}

/**
 * Returns `true` iff a `withProjectLock` call is currently in flight for
 * `projectId`. Intended for diagnostics and tests; route handlers should
 * call `withProjectLock` directly rather than pre-checking, to avoid a
 * time-of-check / time-of-use race.
 */
export function isLocked(projectId: string): boolean {
  return locks.has(projectId);
}
