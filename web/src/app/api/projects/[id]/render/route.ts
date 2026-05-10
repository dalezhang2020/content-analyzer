/**
 * POST /api/projects/{id}/render
 *
 * Local: starts a HyperFrames render subprocess, returns a streamUrl
 *   for SSE progress updates.
 * Vercel: returns 503 LOCAL_ONLY — rendering is performed in Kiro IDE
 *   on the user's machine. The result (MP4 blob URL) is uploaded back
 *   to Neon via the `workbench-render` Kiro skill.
 */

import type { NextRequest } from "next/server";
import { isLocalEnv, localOnlyResponse } from "@/lib/env";

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
  if (!isLocalEnv()) {
    return localOnlyResponse(
      "Video rendering is performed locally via HyperFrames CLI in Kiro IDE",
    );
  }

  try {
    const projectId = await requireProjectIdFromParams(ctx.params);

    // One live render per project.
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

      if (project.stage !== "audio" && project.stage !== "render") {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Render requires stage=audio or stage=render",
          { currentStage: project.stage },
        );
      }

      const running = markStageRunning(project, "render");
      await writeProject(running);

      const { runId: rid, active } = await startRender(running);

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
