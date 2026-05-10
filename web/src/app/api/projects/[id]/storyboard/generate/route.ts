/**
 * Video Creation Workbench — `POST /api/projects/{id}/storyboard/generate`.
 *
 * Generates (or regenerates, via `force: true`) the project Storyboard from
 * `project.brief`. The whole flow runs under `withProjectLock` so concurrent
 * generate calls against the same project fail fast with 409 `LOCK_BUSY`
 * rather than racing on disk.
 *
 * Pipeline:
 *   1. Validate path param via `requireProjectIdFromParams`.
 *   2. Read the optional `{ force?: boolean }` body (generation endpoints
 *      may carry slightly larger payloads — use `REQUEST_BODY_MAX_BYTES_GEN`).
 *      Empty body is accepted; the catch() fallback keeps the route
 *      permissive when clients send nothing at all.
 *   3. Stage guard:
 *      - `stage === "brief"` AND no storyboard yet → allowed (fresh run).
 *      - `force === true` → allowed regardless (overwrite in place).
 *      - otherwise → 409 `INVALID_STAGE`.
 *   4. Brief presence: missing brief → 409 `INVALID_STAGE`.
 *   5. `markStageRunning("storyboard")` → `generateStoryboardFromBrief` →
 *      assign `sceneId` / `index` / default metadata → `writeStoryboard` →
 *      `markStageSucceeded("storyboard")` →
 *      `applyTransition(brief → storyboard)` when coming from `brief`.
 *   6. On any thrown error inside the lock, `markStageFailed("storyboard", …)`
 *      is persisted before rethrowing so the UI can observe the failure.
 *   7. Tolerance-retry warning from `generateStoryboardFromBrief` is passed
 *      through to the response body as `{ project, warning? }`.
 */

import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";

import { generateStoryboardFromBrief } from "@/lib/workbench/ai-generator";
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
  writeProject,
  writeStoryboard,
} from "@/lib/workbench/project-store";
import { ForceFlagSchema } from "@/lib/workbench/schemas";
import {
  applyTransition,
  markStageFailed,
  markStageRunning,
  markStageSucceeded,
} from "@/lib/workbench/state-machine";
import type { Storyboard } from "@/lib/workbench/types";

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

    const result = await withProjectLock(projectId, async () => {
      let project = await readProject(projectId);

      // Stage guard: brief stage with no storyboard = fresh run.
      // Anything else requires `force` so the caller explicitly opts in to
      // overwriting downstream artefacts.
      if (project.stage === "brief" && !project.storyboard) {
        // okay — canonical first-run path
      } else if (force) {
        // okay — caller opted into overwrite
      } else {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Storyboard already generated or Brief not ready",
          {
            currentStage: project.stage,
            hasStoryboard: project.storyboard !== null,
          },
        );
      }

      if (!project.brief) {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Brief is required before storyboard",
          { currentStage: project.stage },
        );
      }

      project = markStageRunning(project, "storyboard");
      try {
        const { scenes: rawScenes, warning } =
          await generateStoryboardFromBrief(project);

        // Upgrade raw storyboard scenes to the full Scene shape: assign a
        // fresh sceneId (`sc_{8hex}`), 1-based contiguous index, empty
        // qaNote/audioPath, and a shared updatedAt stamp.
        const now = new Date().toISOString();
        const scenes = rawScenes.map((s, i) => ({
          sceneId: `sc_${randomBytes(4).toString("hex")}`,
          index: i + 1,
          title: s.title,
          narration: s.narration,
          durationSec: s.durationSec,
          voice: s.voice,
          audioPath: null as string | null,
          qaNote: "",
          updatedAt: now,
        }));
        const storyboard: Storyboard = { scenes };
        await writeStoryboard(projectId, storyboard);

        project = {
          ...project,
          storyboard,
          artifacts: {
            ...project.artifacts,
            storyboardPath: "storyboard.json",
          },
        };
        project = markStageSucceeded(project, "storyboard");
        if (project.stage === "brief") {
          project = applyTransition(project, "storyboard");
        }
        await writeProject(project);
        return { project, warning };
      } catch (err) {
        const code =
          err instanceof WorkbenchError
            ? err.code
            : ErrorCode.LLM_OUTPUT_INVALID;
        const message = err instanceof Error ? err.message : String(err);
        project = markStageFailed(project, "storyboard", { code, message });
        await writeProject(project);
        throw err;
      }
    });

    // Omit `warning` key entirely when undefined so the response envelope
    // stays clean in the tolerance-passing case.
    if (result.warning === undefined) {
      return respondJson({ project: result.project });
    }
    return respondJson(result);
  } catch (e) {
    return respondError(e);
  }
}
