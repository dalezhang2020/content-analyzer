/**
 * Workbench — filesystem helpers (simplified for single-user local app).
 *
 * The original implementation used tmp-file → fsync → rename to guard
 * against partial writes from concurrent processes / crashes. For a
 * local single-user app the extra complexity is not worth it — plain
 * `writeFile` is used directly. API signatures are preserved so callers
 * don't need to change.
 */

import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { ErrorCode, WorkbenchError } from "./errors";

function reasonOf(e: unknown): string {
  if (e instanceof Error && typeof e.message === "string") return e.message;
  return String(e);
}

function isFsErrorCode(e: unknown, code: string): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === code
  );
}

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

export async function atomicWriteJson(
  absPath: string,
  obj: unknown,
  opts?: { spaces?: number },
): Promise<void> {
  const spaces = opts?.spaces ?? 2;
  try {
    await ensureDir(path.dirname(absPath));
    await writeFile(absPath, JSON.stringify(obj, null, spaces), "utf8");
  } catch (e) {
    throw new WorkbenchError(ErrorCode.WRITE_FAILED, reasonOf(e), {
      path: absPath,
      reason: reasonOf(e),
    });
  }
}

export async function atomicWriteBuffer(
  absPath: string,
  buf: Buffer | Uint8Array,
): Promise<void> {
  try {
    await ensureDir(path.dirname(absPath));
    await writeFile(absPath, buf);
  } catch (e) {
    throw new WorkbenchError(ErrorCode.WRITE_FAILED, reasonOf(e), {
      path: absPath,
      reason: reasonOf(e),
    });
  }
}

export async function atomicCopyFile(src: string, dst: string): Promise<void> {
  try {
    await ensureDir(path.dirname(dst));
    await copyFile(src, dst);
  } catch (e) {
    throw new WorkbenchError(ErrorCode.WRITE_FAILED, reasonOf(e), {
      path: dst,
      reason: reasonOf(e),
    });
  }
}

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
    return { succeeded: [], failed: [{ path: absPath, reason: reasonOf(e) }] };
  }
}

export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch (e) {
    if (isFsErrorCode(e, "ENOENT")) return false;
    throw e;
  }
}

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
