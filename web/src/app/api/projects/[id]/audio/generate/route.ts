/**
 * Video Creation Workbench — `POST /api/projects/{id}/audio/generate`.
 *
 * Runs TTS for every scene in the project's storyboard and, on full
 * success, injects canonical `<audio>` tags into `composition/index.html`.
 * Partial failures surface as HTTP 207; a post-inject lint/validate
 * failure triggers an atomic rollback of `index.html` from a pre-flight
 * backup.
 *
 * Pipeline (inside `withProjectLock`):
 *   1. Validate path param; parse optional `{ force?: boolean }` body.
 *   2. Gate on `stage === "composition"` (else 409 `INVALID_STAGE`); gate
 *      on `storyboard` presence (also 409 `INVALID_STAGE`).
 *   3. `markStageRunning("audio")`.
 *   4. `synthesizeAll(project, { force })` walks each scene sequentially,
 *      skipping pre-existing mp3s when `force === false`, and collects
 *      per-scene failures into `TTSBatchResult.failures`.
 *   5. Update `project.storyboard` with the returned scenes and
 *      `artifacts.audioPaths` with the ordered non-null audio paths.
 *   6. Branch:
 *      - `failures.length > 0` → `markStageFailed("audio", …)`, persist,
 *        return HTTP 207 with `{ project, failures }`. Stage stays at
 *        `composition`.
 *      - `failures.length === 0` → back up current `index.html` to
 *        `index.prev.html`, inject canonical audio tags, rewrite HTML,
 *        and run `hyperframes lint` + `validate`.
 *        - On lint/validate failure: restore `index.html` from
 *          `index.prev.html`, `markStageFailed("audio", AUDIO_INJECT_ROLLBACK)`,
 *          persist, throw `AUDIO_INJECT_ROLLBACK` (HTTP 500). If restore
 *          itself fails, surface the same code with a manual-intervention
 *          hint per Req 9.12.
 *        - On success: `markStageSucceeded("audio")` +
 *          `applyTransition("audio")`, persist, return HTTP 200 project.
 *
 * All external errors (missing Azure Speech credentials, timeouts,
 * network, write failures) propagate through the caught-error branch
 * where the audio stage is marked failed before the error is rethrown.
 *
 * _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12_
 */

import type { NextRequest } from "next/server";

import {
  parseJsonBody,
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { atomicWriteBuffer, readFileSafe } from "@/lib/workbench/atomic-fs";
import { injectAudio } from "@/lib/workbench/audio-injector";
import { LIMITS, STAGE_DIRS } from "@/lib/workbench/constants";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { withProjectLock } from "@/lib/workbench/locks";
import { resolveProjectFile } from "@/lib/workbench/path-safety";
import { readProject, writeProject } from "@/lib/workbench/project-store";
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
import { synthesizeAll } from "@/lib/workbench/tts-service";
import type { Project, Storyboard, TTSBatchResult } from "@/lib/workbench/types";

/**
 * Result envelope returned by the locked critical section. `status` lets
 * the outer handler pick the HTTP code without re-deriving it from the
 * payload shape.
 */
type LockedResult =
  | { status: 200; project: Project }
  | { status: 207; project: Project; failures: TTSBatchResult["failures"] };

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);

    // Generation endpoints may receive slightly larger bodies per Req 16.5.
    // An empty body is fine — catch() falls back to {} so `force` defaults
    // to `false` without forcing clients to send anything.
    const body = await parseJsonBody(req, ForceFlagSchema, {
      maxBytes: LIMITS.REQUEST_BODY_MAX_BYTES_GEN,
    }).catch(() => ({}) as { force?: boolean });
    const force = body.force ?? false;

    const result = await withProjectLock<LockedResult>(projectId, async () => {
      let project = await readProject(projectId);

      // Stage gate: `composition` is the canonical predecessor, but
      // `audio` itself is also accepted so a user who regressed to
      // `audio` (via StagePanel "回退到此阶段") can retry audio without
      // being forced to regress further to `composition`. Any other
      // stage is rejected — audio generation depends on scene HTML
      // being on disk. `force` controls the "skip existing mp3"
      // shortcut inside `synthesizeAll`; it does NOT unlock the gate.
      if (project.stage !== "composition" && project.stage !== "audio") {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Audio generation requires stage=composition or stage=audio",
          { currentStage: project.stage },
        );
      }
      if (!project.storyboard) {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Storyboard is required before audio generation",
          { currentStage: project.stage },
        );
      }

      project = markStageRunning(project, "audio");

      // Flag flipped in the post-injection rollback branch so the shared
      // catch block below doesn't re-record the stage as failed on top of
      // the AUDIO_INJECT_ROLLBACK status we already persisted.
      let alreadyRecordedFailure = false;

      try {
        const ttsResult = await synthesizeAll(project, { force });

        // Update storyboard with the returned scenes (successful scenes now
        // carry `audioPath`; failed scenes keep their original path).
        const updatedStoryboard: Storyboard = { scenes: ttsResult.scenes };
        const audioPaths = ttsResult.scenes
          .map((s) => s.audioPath)
          .filter((p): p is string => typeof p === "string" && p.length > 0);

        project = {
          ...project,
          storyboard: updatedStoryboard,
          artifacts: { ...project.artifacts, audioPaths },
        };

        // -----------------------------------------------------------------
        // Partial failure — keep stage=composition, return 207.
        // -----------------------------------------------------------------
        if (ttsResult.failures.length > 0) {
          project = markStageFailed(project, "audio", {
            code: ErrorCode.LLM_OUTPUT_INVALID,
            message: `${ttsResult.failures.length} scene(s) failed TTS`,
          });
          await writeProject(project);
          return {
            status: 207,
            project,
            failures: ttsResult.failures,
          };
        }

        // -----------------------------------------------------------------
        // Full success — inject audio into composition HTML.
        // -----------------------------------------------------------------
        const htmlPath = resolveProjectFile(
          projectId,
          STAGE_DIRS.COMPOSITION,
          "index.html",
        );
        // Use `.bak` suffix instead of `.html` to keep hyperframes lint
        // from discovering the backup as a second root composition (which
        // triggers `multiple_root_compositions`).
        const prevHtmlPath = resolveProjectFile(
          projectId,
          STAGE_DIRS.COMPOSITION,
          "index.prev.html.bak",
        );

        // Backup current HTML BEFORE mutation so a lint/validate failure
        // has something to roll back to. `readFileSafe` maps ENOENT to a
        // READ_FAILED we want the caller to see — a missing index.html at
        // this point is an unrecoverable state bug, not a rollback case.
        const currentHtml = await readFileSafe(htmlPath);
        await atomicWriteBuffer(
          prevHtmlPath,
          Buffer.from(currentHtml, "utf8"),
        );

        // Inject canonical tags for every scene (all succeeded by this
        // branch); `injectAudio` is pure and idempotent across re-runs.
        const successfulIndexes = ttsResult.scenes.map((s) => s.index);
        const newHtml = injectAudio(
          currentHtml,
          updatedStoryboard,
          successfulIndexes,
        );
        await atomicWriteBuffer(htmlPath, Buffer.from(newHtml, "utf8"));

        // Lint first — validate runs only if lint passes so we surface the
        // more actionable error shape when both would fail.
        const lintRes = await runHyperframesLint(projectId);
        const validateRes = lintRes.ok
          ? await runHyperframesValidate(projectId)
          : { ok: false, stderr: lintRes.stderr };

        if (!lintRes.ok || !validateRes.ok) {
          // Rollback: restore `index.html` from the pre-flight backup. If
          // restore itself fails, Req 9.12 asks for a manual-intervention
          // message — surface the same code with extra context in details.
          try {
            const prev = await readFileSafe(prevHtmlPath);
            await atomicWriteBuffer(htmlPath, Buffer.from(prev, "utf8"));
          } catch (restoreErr) {
            project = markStageFailed(project, "audio", {
              code: ErrorCode.AUDIO_INJECT_ROLLBACK,
              message:
                "Audio injection failed AND rollback failed; manual intervention required",
            });
            await writeProject(project);
            alreadyRecordedFailure = true;
            throw new WorkbenchError(
              ErrorCode.AUDIO_INJECT_ROLLBACK,
              "Audio injection failed and rollback from index.prev.html also failed; manual intervention required",
              {
                restoreError:
                  restoreErr instanceof Error
                    ? restoreErr.message
                    : String(restoreErr),
                lintStderr: lintRes.stderr.slice(0, 2000),
                validateStderr: validateRes.stderr.slice(0, 2000),
              },
            );
          }

          // Rollback succeeded — record the stage failure and surface the
          // original lint/validate output so the client can show the user
          // why the injected audio broke the template.
          project = markStageFailed(project, "audio", {
            code: ErrorCode.AUDIO_INJECT_ROLLBACK,
            message: "Audio injection failed lint/validate; HTML rolled back",
          });
          await writeProject(project);
          alreadyRecordedFailure = true;
          throw new WorkbenchError(
            ErrorCode.AUDIO_INJECT_ROLLBACK,
            "Audio injection failed lint/validate; rolled back",
            {
              lintOk: lintRes.ok,
              validateOk: validateRes.ok,
              stderr: (!lintRes.ok ? lintRes.stderr : validateRes.stderr).slice(
                0,
                2000,
              ),
            },
          );
        }

        // All clear — commit the stage transition.
        project = markStageSucceeded(project, "audio");
        // Only advance forward from `composition`. When the caller was
        // already on `audio` (regressed from a later stage for a rerun),
        // the project-level stage is already correct — skip the
        // transition or `applyTransition` would reject `audio → audio`
        // as an illegal edge.
        if (project.stage === "composition") {
          project = applyTransition(project, "audio");
        }
        await writeProject(project);
        return { status: 200, project };
      } catch (err) {
        if (alreadyRecordedFailure) {
          throw err;
        }
        const code =
          err instanceof WorkbenchError ? err.code : ErrorCode.LLM_OUTPUT_INVALID;
        const message = err instanceof Error ? err.message : String(err);
        project = markStageFailed(project, "audio", { code, message });
        await writeProject(project);
        throw err;
      }
    });

    if (result.status === 207) {
      return respondJson(
        { project: result.project, failures: result.failures },
        207,
      );
    }
    return respondJson(result.project, 200);
  } catch (e) {
    return respondError(e);
  }
}
