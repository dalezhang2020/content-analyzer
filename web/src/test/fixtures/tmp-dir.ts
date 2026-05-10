import { afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Feature: video-creation-workbench
// Shared tmp-dir helper for integration/property tests that touch the
// filesystem. Every test that creates a tmp-dir MUST clean it up in
// afterEach — see design.md §Integration Tests ("unique tmp/ directory
// under os.tmpdir() and cleans up in afterEach").

export interface TmpDir {
  /** Absolute path of the freshly-created unique directory. */
  path: string;
  /** Idempotent recursive removal. Safe to call multiple times. */
  cleanup: () => Promise<void>;
}

/**
 * Create a unique temp directory under the OS tmpdir.
 * The caller is responsible for calling `cleanup()` (or use
 * {@link useTmpDir} to get automatic teardown).
 */
export async function createTmpDir(prefix = "workbench-"): Promise<TmpDir> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(path, { recursive: true, force: true });
  };
  return { path, cleanup };
}

/**
 * Vitest-scoped helper: lazily creates a tmp dir on first access and
 * cleans it up after each test. Returns a getter; do not memoize the
 * path across tests.
 *
 * Usage:
 *   const getTmp = useTmpDir();
 *   it("writes a file", async () => {
 *     const { path } = await getTmp();
 *     // ...
 *   });
 */
export function useTmpDir(prefix = "workbench-"): () => Promise<TmpDir> {
  let current: TmpDir | null = null;
  afterEach(async () => {
    if (current) {
      await current.cleanup();
      current = null;
    }
  });
  return async () => {
    if (!current) {
      current = await createTmpDir(prefix);
    }
    return current;
  };
}
