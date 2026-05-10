/**
 * Workbench — project-level lock (no-op on single-user local setup).
 *
 * The original implementation tracked an in-flight promise per projectId
 * and threw `LOCK_BUSY` on reentry. For a single-user local app running
 * one request at a time the failure mode never fires; we keep the API
 * shape so routes don't have to change, but simply await the body.
 */

export async function withProjectLock<T>(
  _projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return fn();
}

export function isProjectLocked(_projectId: string): boolean {
  return false;
}
