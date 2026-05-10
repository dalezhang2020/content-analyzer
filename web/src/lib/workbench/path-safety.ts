/**
 * Video Creation Workbench — path-safety helpers.
 *
 * Every filesystem-touching route and service in the workbench MUST funnel
 * path inputs through this module. It enforces the project-wide identifier
 * regexes (`REGEX.PROJECT_ID`, `REGEX.SCENE_ID`), control-character scrubbing
 * (`CONTROL_CHAR_REGEX`), and the "stay under data dir" containment rule that
 * prevents path traversal from leaking outside `DATA_DIR`.
 *
 * Design notes:
 *   - `getDataDirAbs()` resolves `DATA_DIR` lazily against `process.cwd()` so
 *     merely importing this module cannot crash at load time if the CWD is
 *     unset or permissions differ between environments.
 *   - `assertUnderDataDir` uses `path.relative()` for a symlink-agnostic
 *     containment check: the relative path must not be absolute and must not
 *     begin with `..`.
 *   - `resolveProjectFile` is the canonical way to build an absolute path
 *     inside a project's on-disk directory; callers never hand-roll joins.
 *
 * _Requirements: 2.3, 3.2, 8.7, 16.3, 16.4_
 */

import path from "node:path";

import { CONTROL_CHAR_REGEX, DATA_DIR, REGEX } from "./constants";
import { ErrorCode, WorkbenchError } from "./errors";

// ---------------------------------------------------------------------------
// Identifier regex validators
// ---------------------------------------------------------------------------

/**
 * True when `s` matches the canonical Project ID shape
 * `proj_{ms-timestamp}_{6 lowercase alphanum}`.
 *
 * _Requirements: 2.3_
 */
export function isValidProjectId(s: string): boolean {
  return typeof s === "string" && REGEX.PROJECT_ID.test(s);
}

/**
 * True when `s` matches the canonical Scene ID shape `sc_{8 lowercase hex}`.
 *
 * _Requirements: 3.2_
 */
export function isValidSceneId(s: string): boolean {
  return typeof s === "string" && REGEX.SCENE_ID.test(s);
}

/**
 * Throws `WorkbenchError(INVALID_PROJECT_ID)` when `s` is not a valid Project
 * ID. Narrows `s` to `string` on success.
 *
 * _Requirements: 2.3_
 */
export function assertValidProjectId(s: string): asserts s is string {
  if (!isValidProjectId(s)) {
    throw new WorkbenchError(
      ErrorCode.INVALID_PROJECT_ID,
      "Invalid project ID",
      { input: s },
    );
  }
}

/**
 * Throws `WorkbenchError(INVALID_SCENE_ID)` when `s` is not a valid Scene ID.
 * Narrows `s` to `string` on success.
 *
 * _Requirements: 3.2_
 */
export function assertValidSceneId(s: string): asserts s is string {
  if (!isValidSceneId(s)) {
    throw new WorkbenchError(
      ErrorCode.INVALID_SCENE_ID,
      "Invalid scene ID",
      { input: s },
    );
  }
}

// ---------------------------------------------------------------------------
// Control-character scrubbing
// ---------------------------------------------------------------------------

/**
 * Rejects any string containing ASCII control characters matched by
 * `CONTROL_CHAR_REGEX`. Returns the input unchanged on success.
 *
 * The name is historical ("scrub") but the behaviour is strict rejection —
 * silently stripping control bytes would mask upstream encoding bugs. Call
 * sites that want a sanitised copy should normalise/trim before invoking
 * this guard.
 *
 * _Requirements: 16.3_
 */
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

// ---------------------------------------------------------------------------
// Path-traversal detection
// ---------------------------------------------------------------------------

/**
 * True when `s` contains any of the classic path-traversal markers:
 *   - `..` anywhere in the string (parent-directory escape)
 *   - a leading `/` or `\` (absolute path override)
 *   - a NUL byte (C-string truncation attack)
 *
 * This is a syntactic fast-check; actual containment is enforced by
 * `assertUnderDataDir` after resolution.
 *
 * _Requirements: 16.4_
 */
export function hasPathTraversal(s: string): boolean {
  if (typeof s !== "string") return false;
  if (s.includes("..")) return true;
  if (s.startsWith("/") || s.startsWith("\\")) return true;
  if (s.includes("\x00")) return true;
  return false;
}

/**
 * Throws `WorkbenchError(PATH_TRAVERSAL_REJECTED)` when `s` looks like a
 * traversal attempt. Narrows `s` to `string` on success.
 *
 * _Requirements: 16.4_
 */
export function assertNoPathTraversal(s: string): asserts s is string {
  if (hasPathTraversal(s)) {
    throw new WorkbenchError(
      ErrorCode.PATH_TRAVERSAL_REJECTED,
      "Path traversal detected in input",
      { input: s },
    );
  }
}

// ---------------------------------------------------------------------------
// Data-dir containment
// ---------------------------------------------------------------------------

/**
 * Lazy accessor for the absolute path of `DATA_DIR` resolved against
 * `process.cwd()`.
 *
 * Resolved on each call (cheap — `path.resolve` is pure) so changing CWD in
 * tests is observed. Lazy resolution also prevents a bad CWD at module load
 * time from crashing the whole workbench import graph.
 *
 * _Requirements: 2.1, 8.1_
 */
export function getDataDirAbs(): string {
  return path.resolve(process.cwd(), DATA_DIR);
}

/**
 * Throws `WorkbenchError(PATH_TRAVERSAL_REJECTED)` when `absPath` is not
 * contained within `getDataDirAbs()`.
 *
 * Containment is checked with `path.relative()`:
 *   - the relative path must NOT start with `..` (escapes the root), and
 *   - the relative path must NOT be absolute (different drive / root).
 * An empty relative path (i.e. `absPath === dataDirAbs`) is accepted so the
 * data-dir itself can be passed through as a boundary value.
 *
 * _Requirements: 16.4_
 */
export function assertUnderDataDir(absPath: string): void {
  const dataDirAbs = getDataDirAbs();
  const rel = path.relative(dataDirAbs, absPath);

  if (
    rel.startsWith("..") ||
    rel === ".." ||
    path.isAbsolute(rel)
  ) {
    throw new WorkbenchError(
      ErrorCode.PATH_TRAVERSAL_REJECTED,
      "Resolved path escapes data directory",
      { path: absPath },
    );
  }
}

/**
 * Build an absolute path rooted at `{dataDir}/{projectId}/{...parts}` with
 * full validation:
 *   1. `projectId` must satisfy `REGEX.PROJECT_ID`.
 *   2. Each `part` must be free of traversal markers (`..`, leading separator,
 *      NUL byte).
 *   3. The resolved absolute path must stay under `getDataDirAbs()`.
 *
 * This is the canonical way to construct per-project file paths across the
 * workbench — call sites never pass raw strings into `path.resolve`.
 *
 * _Requirements: 2.3, 8.7, 16.4_
 */
export function resolveProjectFile(
  projectId: string,
  ...parts: string[]
): string {
  assertValidProjectId(projectId);

  for (const part of parts) {
    assertNoPathTraversal(part);
  }

  const abs = path.resolve(getDataDirAbs(), projectId, ...parts);
  assertUnderDataDir(abs);
  return abs;
}
