/**
 * Property tests for `atomic-fs.ts`.
 *
 * Property 7: Atomic writer — coherent reads and no residue on failure.
 *
 * _Validates: Requirements 2.7, 2.8, 4.5, 7.4, 8.9, 9.4, 9.7_
 *
 * The atomic-write helper used by writeProject / writeStoryboard /
 * writeBrief / writeAudioFile / applyTransition must guarantee, for any
 * write to a JSON target file:
 *
 *   (A) coherence      — once `atomicWriteJson(path, obj)` resolves, a
 *                        subsequent read of `path` parses back to exactly
 *                        `obj`, and no `.tmp` sidecar remains in the target
 *                        directory.
 *   (B) failure cleanup — when the final `fs.rename` throws mid-write, any
 *                        pre-existing file at `path` is left byte-identical
 *                        to its prior contents, the `.tmp` sidecar is
 *                        cleaned up, and a typed `WorkbenchError(WRITE_FAILED)`
 *                        is surfaced.
 *   (C) sequential writers — two back-to-back `atomicWriteJson` calls result
 *                        in the second value being the one visible to the
 *                        next read.
 *
 * Failure injection is performed by replacing `rename` on the shared
 * `node:fs/promises` module record through `vi.mock` (ESM module
 * namespaces are non-configurable, so `vi.spyOn` cannot attach to the
 * named export directly). Each iteration arms a one-shot failure through
 * `armRenameFailure()` and disarms it through `clearRenameFailures()`.
 */

import path from "node:path";

import fc from "fast-check";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Mock `node:fs/promises` — replace `rename` with a passthrough that can
// optionally throw a queued error. `...actual` keeps every other export
// (open, readFile, mkdir, stat, unlink, rm, ...) at its real implementation
// so both the tested code *and* the test helpers keep working.
// ---------------------------------------------------------------------------

const renameFailureQueue: Array<Error> = [];

function armRenameFailure(err: Error): void {
  renameFailureQueue.push(err);
}

function clearRenameFailures(): void {
  renameFailureQueue.length = 0;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  const renameOverride = async (src: string, dst: string) => {
    const injected = renameFailureQueue.shift();
    if (injected) throw injected;
    return actual.rename(src, dst);
  };

  // Named `import { rename } from "node:fs/promises"` inside the SUT can
  // resolve through the ESM-interop `default` wrapper, so override both
  // the named export and the `default` surface. Same idiom as
  // render-service.test.ts does for `node:child_process.spawn`.
  return {
    ...actual,
    rename: renameOverride,
    default: {
      ...(actual as unknown as { default?: object }).default,
      rename: renameOverride,
    },
  };
});

// Only imported *after* the mock is declared so the module record we get
// is the mocked one.
import * as fsPromises from "node:fs/promises";
import { atomicWriteJson } from "@/lib/workbench/atomic-fs";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { createTmpDir, type TmpDir } from "@/test/fixtures/tmp-dir";

// ---------------------------------------------------------------------------
// Per-test fixture
// ---------------------------------------------------------------------------

let tmp: TmpDir;

beforeEach(async () => {
  tmp = await createTmpDir("atomic-fs-pbt-");
});

afterEach(async () => {
  clearRenameFailures();
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the names of any `*.tmp` sidecars in `dir`. Used to assert the
 * "no residue" half of the invariant — both on the success path and on
 * the failure-injected path.
 */
async function listTmpResidue(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsPromises.readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".tmp"));
}

/**
 * Arbitrary JSON value. `fc.jsonValue()` emits objects, arrays, numbers,
 * strings, booleans, and `null` — all of which survive the standard
 * `JSON.stringify → JSON.parse` round-trip used by `atomicWriteJson`.
 */
const jsonArb = fc.jsonValue();

// Keep filesystem property runs small; the global config is 100 which is
// fine for pure functions but expensive for real disk I/O.
const FS_RUNS = 30;

// ---------------------------------------------------------------------------
// Property A — coherence + no residue on success
// ---------------------------------------------------------------------------

describe("atomicWriteJson — Property 7 (A: coherence)", () => {
  it("after atomicWriteJson(path, obj), read(path) returns obj and no .tmp remains", async () => {
    await fc.assert(
      fc.asyncProperty(jsonArb, async (payload) => {
        const target = path.join(tmp.path, "project.json");
        await atomicWriteJson(target, payload);

        const text = await fsPromises.readFile(target, "utf8");
        expect(JSON.parse(text)).toStrictEqual(payload);

        expect(await listTmpResidue(tmp.path)).toEqual([]);
      }),
      { numRuns: FS_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property B — failure cleanup: rename throws, original untouched, no .tmp
// ---------------------------------------------------------------------------

describe("atomicWriteJson — Property 7 (B: failure cleanup)", () => {
  it("if fs.rename throws mid-write, original is unchanged and .tmp is cleaned", async () => {
    await fc.assert(
      fc.asyncProperty(jsonArb, jsonArb, async (original, attempted) => {
        const target = path.join(tmp.path, "project.json");

        // Seed the original committed state through the real rename path.
        clearRenameFailures();
        await atomicWriteJson(target, original);
        const bytesBefore = await fsPromises.readFile(target);
        expect(await listTmpResidue(tmp.path)).toEqual([]);

        // Arm a single rename failure for the next call.
        armRenameFailure(
          Object.assign(new Error("injected rename failure"), {
            code: "EIO",
          }),
        );

        let thrown: unknown;
        try {
          await atomicWriteJson(target, attempted);
        } catch (e) {
          thrown = e;
        }

        // (1) A typed WorkbenchError surfaces with the documented code.
        expect(thrown).toBeInstanceOf(WorkbenchError);
        expect((thrown as WorkbenchError).code).toBe(ErrorCode.WRITE_FAILED);

        // (2) No retry happened — the failure queue is drained to empty.
        expect(renameFailureQueue.length).toBe(0);

        // (3) The original file is byte-identical to its pre-write state.
        const bytesAfter = await fsPromises.readFile(target);
        expect(bytesAfter.equals(bytesBefore)).toBe(true);

        // (4) No `.tmp` sidecar remains in the target directory.
        expect(await listTmpResidue(tmp.path)).toEqual([]);
      }),
      { numRuns: FS_RUNS },
    );
  });

  it("failure on first-ever write leaves the target absent and no .tmp residue", async () => {
    await fc.assert(
      fc.asyncProperty(jsonArb, async (attempted) => {
        clearRenameFailures();
        const target = path.join(tmp.path, "fresh.json");

        // Pre-condition: target does not exist.
        await fsPromises.rm(target, { force: true });

        armRenameFailure(
          Object.assign(new Error("injected rename failure"), {
            code: "EIO",
          }),
        );

        let thrown: unknown;
        try {
          await atomicWriteJson(target, attempted);
        } catch (e) {
          thrown = e;
        }

        expect(thrown).toBeInstanceOf(WorkbenchError);
        expect((thrown as WorkbenchError).code).toBe(ErrorCode.WRITE_FAILED);

        // Target never existed, and must still not exist.
        await expect(fsPromises.stat(target)).rejects.toMatchObject({
          code: "ENOENT",
        });

        expect(await listTmpResidue(tmp.path)).toEqual([]);
      }),
      { numRuns: FS_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property C — sequential writers: last write wins, no residue
// ---------------------------------------------------------------------------

describe("atomicWriteJson — Property 7 (C: sequential writers)", () => {
  it("two sequential atomicWriteJson calls leave the second value visible", async () => {
    await fc.assert(
      fc.asyncProperty(jsonArb, jsonArb, async (first, second) => {
        const target = path.join(tmp.path, "project.json");

        await atomicWriteJson(target, first);
        await atomicWriteJson(target, second);

        const text = await fsPromises.readFile(target, "utf8");
        expect(JSON.parse(text)).toStrictEqual(second);

        expect(await listTmpResidue(tmp.path)).toEqual([]);
      }),
      { numRuns: FS_RUNS },
    );
  });
});
