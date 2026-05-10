/**
 * Video Creation Workbench — linear-launch template manager.
 *
 * Owns every filesystem touch that links a Project to the `linear-launch`
 * HyperFrames template:
 *   1. Locate the template directory on disk (`resolveTemplateDir`).
 *   2. Deep-copy it into a new project's `composition/` subtree
 *      (`deepCopyTemplate`), honouring the exclusion ruleset.
 *   3. Compute a best-effort template version string for
 *      `Project.templateSource.version` (`readTemplateVersion`).
 *   4. Selectively re-sync safe files (`hyperframes.json`, `package.json`,
 *      `fonts/`) while preserving user edits to `index.html` / `assets/`
 *      (`syncTemplate`).
 *
 * Design notes:
 *   - `selectFilesToCopy` is a pure, exported function so property tests
 *     (Property 16) can exercise the exclusion ruleset directly against
 *     arbitrary path listings.
 *   - All relative paths are normalised to forward slashes for comparison;
 *     callers of `selectFilesToCopy` must pass POSIX-normalised input. The
 *     walker in `deepCopyTemplate` always emits `"/"`-joined paths.
 *   - Symbolic links are never followed — the walker only recurses on
 *     `dirent.isDirectory()` and only copies on `dirent.isFile()`.
 *   - Every copy goes through `atomicCopyFile`, so readers never observe
 *     half-written files even under concurrent access.
 *   - On any copy failure, the destination subtree is removed best-effort
 *     via `removeTree(dst)` and the original error is wrapped in
 *     `WorkbenchError(TEMPLATE_COPY_FAILED, ..., { src, dst, failedFile })`.
 *
 * _Requirements: 8.2, 8.5, 15.1–15.8; Properties 15, 16, 17_
 */

import { exec } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  atomicCopyFile,
  ensureDir,
  fileExists,
  readFileSafe,
  removeTree,
} from "./atomic-fs";
import { ErrorCode, WorkbenchError } from "./errors";
import type { TemplateSource } from "./types";

const execAsync = promisify(exec);

/**
 * Ordered list of template directory **names** searched under the CWD's
 * siblings. `hf-blank` (from `npx hyperframes init --example blank`) is
 * the canonical HyperFrames baseline — minimal, ~30 lines, zero visual
 * bias. `linear-launch` is kept as a fallback for legacy setups where
 * users haven't scaffolded the blank template yet.
 *
 * `HYPERFRAMES_TEMPLATE_DIR` env override is always tried first and wins
 * over the sibling search.
 */
const TEMPLATE_DIR_NAMES: readonly string[] = ["hf-blank", "linear-launch"];

/**
 * Fallback name written into `TemplateSource.name` when the template's
 * `meta.json` doesn't carry a readable `name` field. Value preserves the
 * pre-hf-blank default for backward compatibility with older projects.
 */
const DEFAULT_TEMPLATE_NAME = "linear-launch" as const;

// ---------------------------------------------------------------------------
// Candidate resolution
// ---------------------------------------------------------------------------

/**
 * Build the ordered candidate list tried by `resolveTemplateDir`.
 * Precedence:
 *   1. `process.env.HYPERFRAMES_TEMPLATE_DIR` (when non-empty)
 *   2. `<cwd>/../{hf-blank, linear-launch}`
 *   3. `<cwd>/../../{hf-blank, linear-launch}`
 *
 * Resolved on each call (not cached) so tests that mutate the environment
 * or CWD observe fresh values.
 *
 * _Requirements: 15.1_
 */
function getTemplateCandidates(): string[] {
  const candidates: string[] = [];
  const envDir = process.env.HYPERFRAMES_TEMPLATE_DIR;
  if (typeof envDir === "string" && envDir.length > 0) {
    candidates.push(envDir);
  }
  const cwd = process.cwd();
  for (const name of TEMPLATE_DIR_NAMES) {
    candidates.push(path.resolve(cwd, "..", name));
  }
  for (const name of TEMPLATE_DIR_NAMES) {
    candidates.push(path.resolve(cwd, "..", "..", name));
  }
  return candidates;
}

/**
 * Locate a HyperFrames template directory by trying each candidate in
 * order and picking the first one whose `hyperframes.json` both exists
 * and is readable.
 *
 * On failure, throws `WorkbenchError(TEMPLATE_NOT_FOUND, ..., { tried })`
 * where `tried` enumerates every candidate attempted with its failure
 * reason — satisfying Criterion 15.2's "explain which paths were tried".
 *
 * Returns `{ sourcePath, version }` where `version` is derived via
 * `readTemplateVersion(sourcePath)`.
 *
 * _Requirements: 8.5, 15.1, 15.2; Property 15_
 */
export async function resolveTemplateDir(): Promise<{
  sourcePath: string;
  version: string;
}> {
  const candidates = getTemplateCandidates();
  const tried: Array<{ path: string; reason: string }> = [];

  for (const candidate of candidates) {
    const hfPath = path.join(candidate, "hyperframes.json");
    try {
      const exists = await fileExists(hfPath);
      if (!exists) {
        tried.push({ path: candidate, reason: "hyperframes.json not found" });
        continue;
      }
      // Readability check — `readFileSafe` throws `READ_FAILED` on permission
      // errors, so a successful read confirms both existence and readability.
      await readFileSafe(hfPath);
    } catch (e) {
      tried.push({
        path: candidate,
        reason: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const version = await readTemplateVersion(candidate);
    return { sourcePath: candidate, version };
  }

  throw new WorkbenchError(
    ErrorCode.TEMPLATE_NOT_FOUND,
    "HyperFrames template not found (looked for hf-blank and linear-launch)",
    { tried },
  );
}

/**
 * Read the template's logical name from its `meta.json`. Falls back to
 * `DEFAULT_TEMPLATE_NAME` when the file is missing or the `name` field
 * is absent / not a string. Never throws — the worst case is a slightly
 * less descriptive `TemplateSource.name` on the persisted Project.
 */
async function readTemplateName(sourcePath: string): Promise<string> {
  try {
    const raw = await readFileSafe(path.join(sourcePath, "meta.json"));
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "name" in parsed &&
      typeof (parsed as { name: unknown }).name === "string" &&
      (parsed as { name: string }).name.length > 0
    ) {
      return (parsed as { name: string }).name;
    }
  } catch {
    // fall through
  }
  return DEFAULT_TEMPLATE_NAME;
}

// ---------------------------------------------------------------------------
// Exclusion ruleset
// ---------------------------------------------------------------------------

/**
 * Normalise a relative path to POSIX form (forward slashes, no leading
 * `./`). `selectFilesToCopy` expects its input already POSIX-normalised;
 * this helper is used internally by `deepCopyTemplate`.
 */
function toPosix(rel: string): string {
  let s = rel.replace(/\\/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  return s;
}

/**
 * Pure exclusion filter: given relative paths (POSIX-normalised), return
 * the subset that should be copied into a project's `composition/`.
 *
 * Exclusion rules (matching Requirement 15.4):
 *   - any path starting with `captures/` (or its Windows form `captures\`)
 *   - any path starting with `.thumbnails/` (or `.thumbnails\`)
 *   - any path ending with `.mp4` (case-insensitive)
 *
 * Guarantees:
 *   - Pure (no I/O, no mutation of input).
 *   - Idempotent: `selectFilesToCopy(selectFilesToCopy(x))` equals
 *     `selectFilesToCopy(x)`.
 *   - Everything not matched by an exclusion rule is retained.
 *
 * _Requirements: 15.3, 15.4; Property 16_
 */
export function selectFilesToCopy(relativePaths: string[]): string[] {
  return relativePaths.filter((rel) => {
    if (rel.startsWith("captures/") || rel.startsWith("captures\\")) {
      return false;
    }
    if (rel.startsWith(".thumbnails/") || rel.startsWith(".thumbnails\\")) {
      return false;
    }
    if (rel.toLowerCase().endsWith(".mp4")) {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Template walking
// ---------------------------------------------------------------------------

/**
 * Recursively walk `src`, returning every regular file's relative path
 * (POSIX-normalised, sorted). Symlinks are ignored — we only recurse on
 * directories and only record files.
 *
 * The output is sorted so deep copies are deterministic: identical source
 * trees always produce identical copy sequences, which keeps failure
 * triage reproducible.
 */
async function walkFiles(src: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    // Sort by name for deterministic traversal order.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const entryRel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(absDir, entry.name), entryRel);
      } else if (entry.isFile()) {
        out.push(toPosix(entryRel));
      }
      // Symlinks and other special entries are intentionally skipped.
    }
  }

  await walk(src, "");
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// Deep copy
// ---------------------------------------------------------------------------

/**
 * Deep-copy the `linear-launch` template from `src` to `dst` using the
 * exclusion rules in `selectFilesToCopy`. Directories that would be empty
 * after filtering (e.g. `captures/`) are NOT created.
 *
 * Sequence per relative file:
 *   1. `ensureDir` on the destination parent directory.
 *   2. `atomicCopyFile(src/rel, dst/rel)` — tmp → fsync → rename.
 *
 * On any copy failure, the partially-populated `dst` is removed best-effort
 * via `removeTree` and the original error is rethrown as
 * `WorkbenchError(TEMPLATE_COPY_FAILED, reason, { src, dst, failedFile })`.
 *
 * _Requirements: 15.3, 15.4, 15.5_
 */
export async function deepCopyTemplate(
  src: string,
  dst: string,
): Promise<void> {
  let files: string[];
  try {
    files = await walkFiles(src);
  } catch (e) {
    throw new WorkbenchError(
      ErrorCode.TEMPLATE_COPY_FAILED,
      e instanceof Error ? e.message : String(e),
      { src, dst, failedFile: null },
    );
  }

  const toCopy = selectFilesToCopy(files);

  for (const rel of toCopy) {
    const srcFile = path.join(src, rel);
    const dstFile = path.join(dst, rel);
    try {
      await ensureDir(path.dirname(dstFile));
      await atomicCopyFile(srcFile, dstFile);
    } catch (e) {
      // Best-effort cleanup — ignore the report; we already have a primary
      // error to surface and nothing productive to do with cleanup failures.
      await removeTree(dst);
      throw new WorkbenchError(
        ErrorCode.TEMPLATE_COPY_FAILED,
        e instanceof Error ? e.message : String(e),
        { src, dst, failedFile: rel },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

/**
 * Resolve the template's version string, preferring stability over novelty:
 *   1. `${src}/package.json`'s `version` field (when a non-empty string).
 *   2. `git rev-parse HEAD` inside `src`, truncated to the 7-char short SHA.
 *   3. The literal string `"unknown"`.
 *
 * All failures are swallowed silently and fall through to the next tier —
 * a missing `package.json` or non-git directory is not an error at this
 * level; it's a reason to keep looking.
 *
 * _Requirements: 15.8_
 */
export async function readTemplateVersion(src: string): Promise<string> {
  // Tier 1: package.json version.
  try {
    const pkgPath = path.join(src, "package.json");
    const raw = await readFileSafe(pkgPath);
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string" &&
      (parsed as { version: string }).version.length > 0
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // fall through
  }

  // Tier 2: git short SHA.
  try {
    const { stdout } = await execAsync("git rev-parse HEAD", { cwd: src });
    const sha = stdout.trim();
    if (sha.length >= 7) {
      return sha.slice(0, 7);
    }
  } catch {
    // fall through
  }

  // Tier 3: unknown.
  return "unknown";
}

// ---------------------------------------------------------------------------
// Sync (merge) template
// ---------------------------------------------------------------------------

/**
 * Recursively copy every file under `srcDir` to `dstDir`, preserving the
 * relative structure. Parent directories are created on demand. Symlinks
 * are ignored.
 *
 * Used by `syncTemplate` to re-sync `fonts/` without pulling in any other
 * template subtree.
 */
async function copyDirRecursive(
  srcDir: string,
  dstDir: string,
): Promise<void> {
  const files = await walkFiles(srcDir);
  for (const rel of files) {
    const srcFile = path.join(srcDir, rel);
    const dstFile = path.join(dstDir, rel);
    await ensureDir(path.dirname(dstFile));
    await atomicCopyFile(srcFile, dstFile);
  }
}

/**
 * Re-sync the safe subset of the template into an existing project's
 * composition directory.
 *
 * Behaviour:
 *   - Compares `dst/hyperframes.json`'s current stringified content against
 *     the `baseline` captured at project-creation time. If they diverge,
 *     the user has modified `hyperframes.json` locally — abort with
 *     `TEMPLATE_CONFLICT` and leave `dst` untouched.
 *   - When no conflict: overwrite `dst/hyperframes.json` and
 *     `dst/package.json` from `src`, and recursively copy `src/fonts/` →
 *     `dst/fonts/`.
 *   - `dst/index.html` and `dst/assets/` are never touched.
 *
 * The conflict check uses `JSON.stringify` equality of the parsed baseline
 * vs. the parsed on-disk file — this is the MVP's simpler equivalent of
 * deep field-by-field comparison (Criterion 15.7).
 *
 * _Requirements: 15.6, 15.7; Property 17_
 */
export async function syncTemplate(
  src: string,
  dst: string,
  baseline: Record<string, unknown>,
): Promise<void> {
  const dstHf = path.join(dst, "hyperframes.json");

  // Parse current dst/hyperframes.json and compare to baseline. A missing
  // file is itself a divergence from baseline (baseline exists, dst does
  // not) — treat as conflict.
  let dstContent: unknown;
  try {
    const raw = await readFileSafe(dstHf);
    dstContent = JSON.parse(raw);
  } catch (e) {
    throw new WorkbenchError(
      ErrorCode.TEMPLATE_CONFLICT,
      "hyperframes.json has local modifications; resolve manually",
      {
        conflicts: ["hyperframes.json"],
        reason: e instanceof Error ? e.message : String(e),
      },
    );
  }

  if (JSON.stringify(dstContent) !== JSON.stringify(baseline)) {
    throw new WorkbenchError(
      ErrorCode.TEMPLATE_CONFLICT,
      "hyperframes.json has local modifications; resolve manually",
      { conflicts: ["hyperframes.json"] },
    );
  }

  // No conflict — apply the template merge.
  const srcHf = path.join(src, "hyperframes.json");
  const srcPkg = path.join(src, "package.json");
  const dstPkg = path.join(dst, "package.json");
  const srcFonts = path.join(src, "fonts");
  const dstFonts = path.join(dst, "fonts");

  await atomicCopyFile(srcHf, dstHf);
  await atomicCopyFile(srcPkg, dstPkg);

  // Copy fonts/ only if the source has it. A missing fonts/ is a no-op.
  if (await fileExists(srcFonts)) {
    await copyDirRecursive(srcFonts, dstFonts);
  }
}

// ---------------------------------------------------------------------------
// Public façade
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper used by `POST /api/projects` to capture the
 * `TemplateSource` snapshot persisted on `Project.templateSource`. Equivalent
 * to `resolveTemplateDir()` wrapped in the `{ name, version, sourcePath }`
 * shape.
 *
 * _Requirements: 15.8_
 */
export async function getTemplateSource(): Promise<TemplateSource> {
  const { sourcePath, version } = await resolveTemplateDir();
  const name = await readTemplateName(sourcePath);
  return {
    name,
    version,
    sourcePath,
  };
}
