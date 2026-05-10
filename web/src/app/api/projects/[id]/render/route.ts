/**
 * Video Creation Workbench — `POST /api/projects/{id}/render`.
 *
 * Kicks off a HyperFrames render subprocess for the project and returns
 * `202 Accepted` with a `runId` + `streamUrl` the client can open as an
 * SSE source (see `./render/stream/route.ts`).
 *
 * Pipeline:
 *   1. Validate path param via `requireProjectIdFromParams`.
 *   2. **Fail-fast** 409 `RENDER_IN_PROGRESS` when an existing ActiveRender
 *      for this project is still `running` — we do NOT queue, because
 *      `render-service` enforces one live render per project at a time
 *      (Req 10.3, Property 21). This check runs **before** lock
 *      acquisition so a second caller never blocks on the first.
 *   3. Acquire `withProjectLock(projectId)` (409 `LOCK_BUSY` on contention).
 *   4. Stage guard: current stage must be exactly `audio`, else 409
 *      `INVALID_STAGE` with `details.currentStage`.
 *   5. `markStageRunning("render")` → persist.
 *   6. `startRender(project)` — returns `{ runId, active }` immediately
 *      while the subprocess continues in the background.
 *   7. Spawn a detached state-update task that consumes the render event
 *      stream until a terminal event (`stage: done` or `stage: failed`)
 *      arrives, then re-reads the Project, writes `artifacts.videoPath`
 *      + `applyTransition("render")` on success, or `markStageFailed`
 *      on failure. This task runs outside the lock so the render call
 *      can return `202` without holding the mutex for 180 s.
 *   8. Respond `202` with `{ runId, streamUrl }`.
 */

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { withProjectLock } from "@/lib/workbench/locks";
import { readProject, writeProject } from "@/lib/workbench/project-store";
import {
  getActiveRender,
  startRender,
  subscribeRender,
} from "@/lib/workbench/render-service";
import {
  applyTransition,
  markStageFailed,
  markStageRunning,
  markStageSucceeded,
} from "@/lib/workbench/state-machine";

type RouteContext = {
  params:
    | Record<string, string | string[]>
    | Promise<Record<string, string | string[]>>;
};

export async function POST(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);

    // ---- Fail-fast: one live render per project. ----------------------
    // This check intentionally sits *outside* `withProjectLock` so the
    // second caller short-circuits with 409 RENDER_IN_PROGRESS without
    // ever blocking on the lock slot. `render-service` is the authority
    // on `status` — we trust its in-memory record.
    const existing = getActiveRender(projectId);
    if (existing && existing.status === "running") {
      throw new WorkbenchError(
        ErrorCode.RENDER_IN_PROGRESS,
        "A render is already in progress",
        { runId: existing.runId },
      );
    }

    const { runId } = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);

      // Stage gate: `audio` is the canonical predecessor, but `render`
      // itself is also accepted so a user who regressed to `render` (via
      // StagePanel's "回退到此阶段") can retry the render step without
      // being forced to regress further to `audio`. Any other stage
      // (topic/brief/storyboard/composition/qa/published) is rejected —
      // a render depends on `audio` having produced mp3s.
      if (project.stage !== "audio" && project.stage !== "render") {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Render requires stage=audio or stage=render",
          { currentStage: project.stage },
        );
      }

      // Enter the `render` stage lifecycle (running). Persist so the UI
      // sees a spinner the next time it polls.
      const running = markStageRunning(project, "render");
      await writeProject(running);

      const { runId: rid, active } = await startRender(running);

      // Detached terminal-state handler. Reads the project fresh at the
      // moment the render finishes so we pick up any concurrent edits
      // (e.g. another lock holder that wrote between `writeProject`
      // above and the terminal event), then applies success/failure
      // status transitions. Runs outside the lock because renders can
      // take up to `TIMEOUTS_MS.HYPERFRAMES_RENDER` (180 s) and we do
      // not want to hold the project mutex that long.
      void (async () => {
        try {
          for await (const ev of subscribeRender(projectId)) {
            if (
              ev.type !== "stage" ||
              (ev.stage !== "done" && ev.stage !== "failed")
            ) {
              continue;
            }

            let finalProject = await readProject(projectId);

            if (ev.stage === "done" && active.videoPath) {
              finalProject = {
                ...finalProject,
                artifacts: {
                  ...finalProject.artifacts,
                  videoPath: active.videoPath,
                },
              };
              finalProject = markStageSucceeded(finalProject, "render");
              // Advance project-level stage only when coming from the
              // canonical `audio` predecessor. When the caller was
              // already on `render` (manual retry after regression), the
              // project-level stage is already correct — just refresh
              // the `succeeded` status. A concurrent regression from QA
              // could also have bumped us off `audio` underneath; in
              // that case we skip the forward transition to avoid an
              // illegal edge.
              if (finalProject.stage === "audio") {
                finalProject = applyTransition(finalProject, "render");
              }
            } else {
              const err = active.error ?? {
                code: ErrorCode.RENDER_TIMEOUT,
                message: "Render failed",
              };
              finalProject = markStageFailed(finalProject, "render", {
                code: err.code,
                message: err.message,
              });
            }

            await writeProject(finalProject);
            break;
          }
        } catch (bgErr) {
          // Never let background errors crash the server — log and move on.
          console.error(
            "[render route] background state update failed:",
            bgErr,
          );
        }
      })();

      return { runId: rid };
    });

    return respondJson(
      {
        runId,
        streamUrl: `/api/projects/${projectId}/render/stream`,
      },
      202,
    );
  } catch (e) {
    return respondError(e);
  }
}
