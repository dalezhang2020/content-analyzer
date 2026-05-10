/**
 * Video Creation Workbench — `POST /api/projects/{id}/brief/generate`.
 *
 * Generates (or regenerates, via `force: true`) the project Brief from
 * `project.topic`. The whole flow runs under `withProjectLock` so
 * concurrent generate calls against the same project fail fast with 409
 * `LOCK_BUSY` rather than racing on disk.
 *
 * Pipeline:
 *   1. Validate path param via `requireProjectIdFromParams`.
 *   2. Read the optional `{ force?: boolean }` body (generation endpoints
 *      may carry slightly larger payloads — use `REQUEST_BODY_MAX_BYTES_GEN`).
 *      Empty body is accepted; the catch() fallback keeps the route
 *      permissive when clients send nothing at all.
 *   3. Stage guard:
 *      - `stage === "topic"` → allowed (fresh brief).
 *      - `force === true` → allowed regardless (overwrite in place).
 *      - otherwise → 409 `INVALID_STAGE`.
 *   4. Topic sanity: empty or over `LIMITS.TOPIC_MAX` → 422 `TOPIC_INVALID`.
 *   5. `markStageRunning("brief")` → `generateBrief` → `writeBrief` →
 *      `markStageSucceeded("brief")` → `applyTransition(topic → brief)`
 *      when coming from `topic`.
 *   6. On any thrown error inside the lock, `markStageFailed("brief", …)`
 *      is persisted before rethrowing so the UI can observe the failure.
 */

import type { NextRequest } from "next/server";

import { generateBrief } from "@/lib/workbench/ai-generator";
import {
  parseJsonBody,
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { LIMITS } from "@/lib/workbench/constants";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { withProjectLock } from "@/lib/workbench/locks";
import {
  readProject,
  writeBrief,
  writeProject,
} from "@/lib/workbench/project-store";
import { ForceFlagSchema } from "@/lib/workbench/schemas";
import {
  markStageFailed,
  markStageRunning,
  markStageSucceeded,
} from "@/lib/workbench/state-machine";

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

      // Stage guard: if a brief already exists, require force=true to
      // regenerate — downstream artefacts (storyboard/composition/audio)
      // will become stale, which is the user's call.
      if (project.brief && !force) {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Brief already generated; pass force:true to regenerate",
          { currentStage: project.stage },
        );
      }

      if (
        !project.topic ||
        project.topic.trim().length === 0 ||
        project.topic.length > LIMITS.TOPIC_MAX
      ) {
        throw new WorkbenchError(
          ErrorCode.TOPIC_INVALID,
          "Project topic is empty or too long",
          { topicLength: project.topic.length },
        );
      }

      project = markStageRunning(project, "brief");
      try {
        const brief = await generateBrief(project);
        await writeBrief(projectId, brief);
        project = {
          ...project,
          brief,
          artifacts: { ...project.artifacts, briefPath: "brief.json" },
        };
        project = markStageSucceeded(project, "brief");
        await writeProject(project);
        return project;
      } catch (err) {
        const code =
          err instanceof WorkbenchError ? err.code : ErrorCode.LLM_OUTPUT_INVALID;
        const message = err instanceof Error ? err.message : String(err);
        project = markStageFailed(project, "brief", { code, message });
        await writeProject(project);
        throw err;
      }
    });

    return respondJson(updated);
  } catch (e) {
    return respondError(e);
  }
}
