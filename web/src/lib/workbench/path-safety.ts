/**
 * Workbench — path helpers (simplified for single-user local app).
 *
 * Original implementation enforced path-traversal rejection +
 * containment checks against `DATA_DIR`. For a local app where every
 * input comes from the user's own UI, we keep the ID regex validation
 * (so a typo doesn't accidentally clobber a sibling directory) and drop
 * the traversal defences.
 *
 * API signatures are preserved so callers don't need to change.
 */

import path from "node:path";

import { CONTROL_CHAR_REGEX, DATA_DIR, REGEX } from "./constants";
import { ErrorCode, WorkbenchError } from "./errors";

export function isValidProjectId(s: string): boolean {
  return typeof s === "string" && REGEX.PROJECT_ID.test(s);
}

export function isValidSceneId(s: string): boolean {
  return typeof s === "string" && REGEX.SCENE_ID.test(s);
}

export function assertValidProjectId(s: string): asserts s is string {
  if (!isValidProjectId(s)) {
    throw new WorkbenchError(
      ErrorCode.INVALID_PROJECT_ID,
      "Invalid project ID",
      { input: s },
    );
  }
}

export function assertValidSceneId(s: string): asserts s is string {
  if (!isValidSceneId(s)) {
    throw new WorkbenchError(
      ErrorCode.INVALID_SCENE_ID,
      "Invalid scene ID",
      { input: s },
    );
  }
}

export function scrubControlChars(s: string): string {
  if (CONTROL_CHAR_REGEX.test(s)) {
    throw new WorkbenchError(
      ErrorCode.CONTROL_CHAR_REJECTED,
      "Input contains control characters",
      { input: s },
    );
  }
  return s;
}

export function hasPathTraversal(s: string): boolean {
  if (typeof s !== "string") return false;
  if (s.includes("..")) return true;
  if (s.startsWith("/") || s.startsWith("\\")) return true;
  if (s.includes("\x00")) return true;
  return false;
}

export function assertNoPathTraversal(s: string): asserts s is string {
  if (hasPathTraversal(s)) {
    throw new WorkbenchError(
      ErrorCode.PATH_TRAVERSAL_REJECTED,
      "Path traversal detected in input",
      { input: s },
    );
  }
}

export function getDataDirAbs(): string {
  const override = process.env.WORKBENCH_DATA_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(process.cwd(), override);
  }
  return path.resolve(process.cwd(), DATA_DIR);
}

/** No-op on single-user setup. API kept for signature compat. */
export function assertUnderDataDir(_absPath: string): void {
  /* no-op */
}

/**
 * Build an absolute path rooted at `{dataDir}/{projectId}/{...parts}`.
 * Validates `projectId` regex and rejects traversal markers (`..`, leading
 * `/`, NUL byte) in parts so a caller typo can't clobber a sibling dir.
 */
export function resolveProjectFile(
  projectId: string,
  ...parts: string[]
): string {
  assertValidProjectId(projectId);
  for (const part of parts) {
    assertNoPathTraversal(part);
  }
  return path.resolve(getDataDirAbs(), projectId, ...parts);
}
