/**
 * Video Creation Workbench — `POST /api/projects/{id}/composition/generate`.
 *
 * Generates (or regenerates, via `force: true`) the project's HyperFrames
 * HTML composition from `project.storyboard`. The whole flow runs under
 * `withProjectLock` so concurrent generate calls against the same project
 * fail fast with 409 `LOCK_BUSY` rather than racing on disk.
 *
 * Pipeline:
 *   1. Validate path param via `requireProjectIdFromParams`.
 *   2. Read the optional `{ force?: boolean }` body (generation endpoints
 *      may carry slightly larger payloads — use `REQUEST_BODY_MAX_BYTES_GEN`).
 *      Empty body is accepted via the catch() fallback.
 *   3. Stage guard:
 *      - `stage === "storyboard"` AND no `indexHtmlPath` → fresh run.
 *      - `force === true` → allowed (overwrite in place).
 *      - otherwise → 409 `INVALID_STAGE`.
 *   4. Storyboard presence: missing storyboard → 409 `INVALID_STAGE`.
 *   5. `markStageRunning("composition")` → LLM generate → `scanHtml`
 *      forbidden-token check → `writeCompositionHtml` → `hyperframes lint`
 *      → `hyperframes validate`.
 *   6. On first-attempt lint/validate failure, one repair retry: regenerate
 *      with stderr context, rerun scan/write/lint/validate.
 *   7. On final failure: preserve the rejected HTML as
 *      `composition/index.failed.html` so a human can inspect it, map the
 *      failure to `LINT_FAILED` / `VALIDATE_FAILED` (both 502), and include
 *      the stderr tail (truncated to 4000 chars) in `details`.
 *   8. On success: update `artifacts` (`indexHtmlPath`, `compositionDir`,
 *      `hyperframesJsonPath`), `markStageSucceeded("composition")`, and
 *      `applyTransition(storyboard → composition)` when coming from
 *      `storyboard`.
 *   9. On any thrown error inside the lock, `markStageFailed("composition", …)`
 *      is persisted before rethrowing so the UI can observe the failure.
 *
 * _Requirements: 6.1–6.8, 16.7_
 */

import type { NextRequest } from "next/server";

import { generateCompositionHtml } from "@/lib/workbench/ai-generator";
import {
  parseJsonBody,
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { atomicWriteBuffer } from "@/lib/workbench/atomic-fs";
import { LIMITS, STAGE_DIRS } from "@/lib/workbench/constants";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { scanHtml } from "@/lib/workbench/html-scanner";
import { withProjectLock } from "@/lib/workbench/locks";
import { resolveProjectFile } from "@/lib/workbench/path-safety";
import {
  readCompositionHtml,
  readProject,
  writeCompositionHtml,
  writeProject,
} from "@/lib/workbench/project-store";
import {
  runHyperframesLint,
  runHyperframesValidate,
} from "@/lib/workbench/render-service";
import { ForceFlagSchema } from "@/lib/workbench/schemas";
import {
  applyTransition,
  markStageFailed,
  markStageRunning,
  markStageSucceeded,
} from "@/lib/workbench/state-machine";

/** Max characters of stderr surfaced back in the 502 response. _Req 6.7_ */
const STDERR_MAX = 4000;

/**
 * Run `hyperframes lint` then, only if lint passed, `hyperframes validate`.
 * Returns a uniform `{ ok, stderr, failedCmd }` shape so the caller can
 * decide which ErrorCode to surface without re-inspecting the individual
 * command results.
 */
async function lintAndValidate(
  projectId: string,
): Promise<{ ok: boolean; stderr: string; failedCmd: "lint" | "validate" | null }> {
  const lint = await runHyperframesLint(projectId);
  if (!lint.ok) {
    return { ok: false, stderr: lint.stderr, failedCmd: "lint" };
  }
  const validate = await runHyperframesValidate(projectId);
  if (!validate.ok) {
    return { ok: false, stderr: validate.stderr, failedCmd: "validate" };
  }
  return { ok: true, stderr: "", failedCmd: null };
}

/**
 * Write the rejected HTML to `composition/index.failed.html` so a human
 * can inspect why the repair cycle gave up. Best-effort — we don't want a
 * cleanup I/O failure to shadow the primary LINT/VALIDATE error.
 */
async function preserveFailedHtml(
  projectId: string,
  html: string,
): Promise<void> {
  try {
    const failedPath = resolveProjectFile(
      projectId,
      STAGE_DIRS.COMPOSITION,
      "index.failed.html",
    );
    await atomicWriteBuffer(failedPath, Buffer.from(html, "utf8"));
  } catch {
    // Swallow — the primary failure is what the caller needs to see.
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const body = await parseJsonBody(req, ForceFlagSchema, {
      maxBytes: LIMITS.REQUEST_BODY_MAX_BYTES_GEN,
    }).catch(() => ({}) as { force?: boolean });
    const force = body.force ?? false;

    const updated = await withProjectLock(projectId, async () => {
      let project = await readProject(projectId);

      // Stage guard: storyboard stage with no HTML yet = fresh run.
      // Anything else (already have an indexHtmlPath, or stage past
      // storyboard) requires `force` so the caller explicitly opts in to
      // overwriting downstream artefacts.
      if (
        project.stage === "storyboard" &&
        !project.artifacts.indexHtmlPath
      ) {
        // okay — canonical first-run path
      } else if (force) {
        // okay — caller opted into overwrite
      } else {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Composition already generated or Storyboard not ready",
          {
            currentStage: project.stage,
            hasIndexHtml: project.artifacts.indexHtmlPath !== null,
          },
        );
      }

      if (!project.storyboard || project.storyboard.scenes.length === 0) {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Storyboard required before composition",
          { currentStage: project.stage },
        );
      }

      project = markStageRunning(project, "composition");
      try {
        // ---- Attempt 1: fresh generation -----------------------------
        let html = await generateCompositionHtml(project);
        let scan = scanHtml(html);
        if (!scan.ok) {
          throw new WorkbenchError(
            ErrorCode.LLM_OUTPUT_INVALID,
            `LLM returned forbidden token: ${scan.hit}`,
            { hit: scan.hit },
          );
        }
        await writeCompositionHtml(projectId, html);
        let check = await lintAndValidate(projectId);

        // ---- Attempt 2 (repair): only if attempt 1 failed -------------
        if (!check.ok) {
          html = await generateCompositionHtml(project, check.stderr);
          scan = scanHtml(html);
          if (!scan.ok) {
            // The rejected repair output never lands as `index.html`;
            // preserve it as `index.failed.html` for inspection.
            await preserveFailedHtml(projectId, html);
            throw new WorkbenchError(
              ErrorCode.LLM_OUTPUT_INVALID,
              `Repair attempt returned forbidden token: ${scan.hit}`,
              { hit: scan.hit },
            );
          }
          await writeCompositionHtml(projectId, html);
          check = await lintAndValidate(projectId);

          if (!check.ok) {
            // Final failure — copy whatever is currently on disk into
            // `index.failed.html` so the user can diff it against the
            // linter's complaints.
            const failedHtml = await readCompositionHtml(projectId).catch(
              () => html,
            );
            await preserveFailedHtml(projectId, failedHtml);

            const truncatedStderr = check.stderr.slice(0, STDERR_MAX);
            const code =
              check.failedCmd === "lint"
                ? ErrorCode.LINT_FAILED
                : ErrorCode.VALIDATE_FAILED;
            throw new WorkbenchError(code, truncatedStderr, {
              stderr: truncatedStderr,
              failedCmd: check.failedCmd,
            });
          }
        }

        // ---- Success -----------------------------------------------
        project = {
          ...project,
          artifacts: {
            ...project.artifacts,
            indexHtmlPath: "composition/index.html",
            compositionDir: "composition",
            hyperframesJsonPath: "composition/hyperframes.json",
          },
        };
        project = markStageSucceeded(project, "composition");
        if (project.stage === "storyboard") {
          project = applyTransition(project, "composition");
        }
        await writeProject(project);
        return project;
      } catch (err) {
        const code =
          err instanceof WorkbenchError
            ? err.code
            : ErrorCode.LLM_OUTPUT_INVALID;
        const message = err instanceof Error ? err.message : String(err);
        project = markStageFailed(project, "composition", { code, message });
        await writeProject(project);
        throw err;
      }
    });

    return respondJson(updated);
  } catch (e) {
    return respondError(e);
  }
}
