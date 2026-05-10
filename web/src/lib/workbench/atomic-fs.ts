/**
 * Video Creation Workbench — atomic filesystem helpers.
 *
 * Every mutating write in the workbench MUST go through this module. The
 * pattern is always: write `${target}.tmp` → `fsync` → `rename` → on any
 * error `unlink .tmp` best-effort. Readers therefore never observe a
 * partially-written target; at worst they see the previous committed
 * contents.
 *
 * Design notes:
 *   - `atomicWriteJson` / `atomicWriteBuffer` / `atomicCopyFile` all share
 *     the same write-temp → fsync → rename scaffold, keyed off a single
 *     internal `writeAndCommit` helper.
 *   - Parent directories are created eagerly (`mkdir({ recursive: true })`)
 *     so callers never need to pre-stage directory trees themselves.
 *   - On any failure during the temp-write or rename, the `.tmp` file is
 *     unlinked as a best-effort cleanup; ENOENT from that cleanup is
 *     swallowed (nothing to remove = goal state reached).
 *   - Errors are wrapped in `WorkbenchError(WRITE_FAILED | READ_FAILED)`
 *     with structured `details` including the target `path` and underlying
 *     `reason`. `ENOENT` on reads surfaces as `READ_FAILED` with a
 *     `"Not found"` message so the caller can distinguish "file absent"
 *     from "file unreadable".
 *   - No logger import here: this module is the bottom-most filesystem
 *     layer and logging is the caller's concern. Avoiding the import also
 *     sidesteps any potential circular reference between logger ↔ atomic-fs.
 *
 * _Requirements: 2.7, 2.8, 4.5, 7.4, 8.9, 9.4, 9.7; Property 7_
 */

import path from "node:path";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";

import { ErrorCode, WorkbenchError } from "./errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable reason string from an unknown thrown value.
 * Falls back to `String(e)` when the error has no `message` property.
 */
function reasonOf(e: unknown): string {
  if (e instanceof Error && typeof e.message === "string") return e.message;
  return String(e);
}

/**
 * True if `e` is a Node-shaped filesystem error with the given `code`.
 * Node's fs errors carry a `.code` string like `"ENOENT"`, `"EACCES"`.
 */
function isFsErrorCode(e: unknown, code: string): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === code
  );
}

/**
 * Best-effort removal of a temp file. Swallows ENOENT (nothing to clean)
 * but otherwise ignores errors — this runs inside a `catch` block where
 * the original error is what callers want to see.
 */
async function cleanupTmp(tmpPath: string): Promise<void> {
  try {
    await unlink(tmpPath);
  } catch (e) {
    if (isFsErrorCode(e, "ENOENT")) return;
    // Any other cleanup failure is intentionally swallowed — we already
    // have a primary error to surface and nothing productive to do here.
  }
}

/**
 * Core write-and-commit primitive shared by `atomicWriteJson`,
 * `atomicWriteBuffer`, and `atomicCopyFile`. Opens `${absPath}.tmp` for
 * `O_CREAT | O_WRONLY | O_TRUNC`, lets `writer` populate it, fsyncs,
 * closes, then renames to `absPath`. On any failure it cleans up the
 * temp file and throws `WorkbenchError(WRITE_FAILED)` with details.
 */
async function writeAndCommit(
  absPath: string,
  writer: (fh: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<void> {
  const tmpPath = `${absPath}.tmp`;
  try {
    await ensureDir(path.dirname(absPath));
    // "wx" would reject an existing tmp; we use "w" (O_CREAT | O_WRONLY |
    // O_TRUNC) so leftover tmp files from a previous crash are safely
    // overwritten rather than blocking the current write.
    const fh = await open(tmpPath, "w");
    try {
      await writer(fh);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, absPath);
  } catch (e) {
    await cleanupTmp(tmpPath);
    throw new WorkbenchError(ErrorCode.WRITE_FAILED, reasonOf(e), {
      path: absPath,
      reason: reasonOf(e),
    });
  }
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/**
 * `mkdir -p` wrapper. Idempotent; a pre-existing directory is not an error.
 *
 * _Requirements: 2.7, 9.4_
 */
export async function ensureDir(absPath: string): Promise<void> {
  try {
    await mkdir(absPath, { recursive: true });
  } catch (e) {
    throw new WorkbenchError(ErrorCode.WRITE_FAILED, reasonOf(e), {
      path: absPath,
      reason: reasonOf(e),
    });
  }
}

// ---------------------------------------------------------------------------
// Atomic writers
// ---------------------------------------------------------------------------

/**
 * Serialise `obj` as pretty JSON and atomically write it to `absPath`.
 * Ensures the parent directory exists. On any error cleans up `.tmp` and
 * throws `WorkbenchError(WRITE_FAILED, ..., { path, reason })`.
 *
 * _Requirements: 2.7, 2.8_
 */
export async function atomicWriteJson(
  absPath: string,
  obj: unknown,
  opts?: { spaces?: number },
): Promise<void> {
  const spaces = opts?.spaces ?? 2;
  const json = JSON.stringify(obj, null, spaces);
  await writeAndCommit(absPath, async (fh) => {
    await fh.writeFile(json, "utf8");
  });
}

/**
 * Atomically write the given binary buffer to `absPath` (e.g. TTS mp3
 * payloads). Same failure semantics as `atomicWriteJson`.
 *
 * _Requirements: 7.4, 9.4_
 */
export async function atomicWriteBuffer(
  absPath: string,
  buf: Buffer | Uint8Array,
): Promise<void> {
  await writeAndCommit(absPath, async (fh) => {
    await fh.writeFile(buf);
  });
}

/**
 * Atomically copy `src` to `dst`. Reads the full contents of `src` and
 * commits them to `dst` via the temp-file → fsync → rename scaffold, so
 * a reader of `dst` never observes a half-copied file. The source file
 * is not modified.
 *
 * _Requirements: 4.5, 8.9_
 */
export async function atomicCopyFile(src: string, dst: string): Promise<void> {
  let data: Buffer;
  try {
    data = await readFile(src);
  } catch (e) {
    throw new WorkbenchError(ErrorCode.WRITE_FAILED, reasonOf(e), {
      path: dst,
      reason: reasonOf(e),
    });
  }
  await atomicWriteBuffer(dst, data);
}

// ---------------------------------------------------------------------------
// Tree removal
// ---------------------------------------------------------------------------

/**
 * Recursively remove `absPath` (file or directory). The MVP report shape
 * is coarse: one entry in `succeeded` when the whole tree is removed,
 * one entry in `failed` when `fs.rm` throws. Fine-grained per-entry
 * enumeration can be added later without changing the signature.
 *
 * Uses `{ recursive: true, force: true }`, so a missing path is treated
 * as success (nothing to remove = goal state reached) rather than an
 * error.
 */
export async function removeTree(
  absPath: string,
): Promise<{
  succeeded: string[];
  failed: Array<{ path: string; reason: string }>;
}> {
  try {
    await rm(absPath, { recursive: true, force: true });
    return { succeeded: [absPath], failed: [] };
  } catch (e) {
    return {
      succeeded: [],
      failed: [{ path: absPath, reason: reasonOf(e) }],
    };
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * True if `absPath` exists. Returns `false` on ENOENT; rethrows any
 * other filesystem error (e.g. EACCES) so callers don't silently treat
 * permission problems as "file absent".
 */
export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch (e) {
    if (isFsErrorCode(e, "ENOENT")) return false;
    throw e;
  }
}

/**
 * Read a text file and surface errors as `WorkbenchError(READ_FAILED)`
 * with structured `{ path, reason }` details. ENOENT surfaces as
 * `"Not found"` so callers can distinguish absence from other failures
 * by the message without inspecting the cause chain.
 *
 * _Requirements: 9.7_
 */
export async function readFileSafe(
  absPath: string,
  encoding: BufferEncoding = "utf8",
): Promise<string> {
  try {
    return await readFile(absPath, encoding);
  } catch (e) {
    const reason = isFsErrorCode(e, "ENOENT") ? "Not found" : reasonOf(e);
    throw new WorkbenchError(ErrorCode.READ_FAILED, reason, {
      path: absPath,
      reason,
    });
  }
}
