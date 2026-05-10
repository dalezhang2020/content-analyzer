/**
 * Video Creation Workbench — `POST /api/projects/{id}/scenes/{sceneId}/rewrite`.
 *
 * LLM-driven rewrite of a single scene's narration (and optionally
 * `durationSec`) driven by a user-authored QA note. The whole flow runs
 * under `withProjectLock` so concurrent rewrite calls against the same
 * project fail fast with 409 `LOCK_BUSY`.
 *
 * Pipeline:
 *   1. Validate path params + parse `SceneRewriteInputSchema` body
 *      (`{ qaNote: string 1–500 }`).
 *   2. Read project; require `storyboard` present and `stage ∈
 *      {storyboard, composition, audio, render, qa}` (anything earlier
 *      has no storyboard to rewrite against) — else 409 `INVALID_STAGE`.
 *   3. Locate the target scene; else 404 `SCENE_NOT_FOUND`.
 *   4. Call `rewriteScene(project, scene, qaNote)` — no retry on LLM
 *      failure per Req 7.7, `LLM_OUTPUT_INVALID` surfaces as 502.
 *   5. Apply `validateSceneRewrite(old, new, qaNote)` — when it returns
 *      `false`, reject with 502 `LLM_OUTPUT_INVALID` (the LLM's proposed
 *      duration drifted outside the ±30% tolerance without a keyword
 *      override).
 *   6. Compute the storyboard's old and new total durations with the
 *      target scene replaced, then `compositionRegenRequired(old, new)`
 *      decides whether the composition HTML must be regenerated
 *      (>10% drift).
 *   7. `applySceneEdit(scene, {narration, durationSec, qaNote})` updates
 *      the scene in-place; because narration changed (and possibly
 *      duration), `audioPath` is cleared automatically (Property 10).
 *   8. Regress downstream `stageStatus` entries to `pending` so the UI
 *      can prompt the user to re-run them. Note: we deliberately do NOT
 *      call `applyTransition` here — the state machine only allows
 *      `qa → storyboard|composition|audio` regressions, and we want
 *      scene rewrites to be callable from composition/audio/render as
 *      well. The user's `stage` is left untouched; the UI drives any
 *      re-run via the cleared stageStatus + `compositionRegenRequired`.
 *   9. `writeProject`; return
 *      `{ scene, compositionRegenRequired }`.
 */

import type { NextRequest } from "next/server";

import { rewriteScene } from "@/lib/workbench/ai-generator";
import {
  parseJsonBody,
  requireProjectIdFromParams,
  requireSceneIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { withProjectLock } from "@/lib/workbench/locks";
import { readProject, writeProject } from "@/lib/workbench/project-store";
import { SceneRewriteInputSchema } from "@/lib/workbench/schemas";
import { applySceneEdit } from "@/lib/workbench/scene-reindexer";
import {
  compositionRegenRequired,
  validateSceneRewrite,
} from "@/lib/workbench/scene-rewrite-rules";
import type {
  Scene,
  Stage,
  StageStatusMap,
  Storyboard,
} from "@/lib/workbench/types";

/**
 * Stages at which a scene rewrite is meaningful: a storyboard must exist
 * and no irreversible publication has occurred. `topic` / `brief` have
 * no storyboard yet; `published` is terminal.
 */
const REWRITE_ALLOWED_STAGES = new Set<Stage>([
  "storyboard",
  "composition",
  "audio",
  "render",
]);

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; sceneId: string }> },
): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const sceneId = await requireSceneIdFromParams(ctx.params);
    const { qaNote } = await parseJsonBody(req, SceneRewriteInputSchema);

    const result = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);

      if (!project.storyboard) {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Storyboard not present — cannot rewrite scene",
          { currentStage: project.stage },
        );
      }
      if (!REWRITE_ALLOWED_STAGES.has(project.stage)) {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Scene rewrite requires storyboard stage or later",
          { currentStage: project.stage },
        );
      }

      const scene = project.storyboard.scenes.find(
        (s) => s.sceneId === sceneId,
      );
      if (!scene) {
        throw new WorkbenchError(
          ErrorCode.SCENE_NOT_FOUND,
          "Scene not found",
          { projectId, sceneId },
        );
      }

      // No retry budget per Req 7.7 — any LLM failure (timeout, schema,
      // network) surfaces as the originating WorkbenchError.
      const rewrite = await rewriteScene(project, scene, qaNote);
      const newDurationSec = rewrite.durationSec ?? scene.durationSec;

      if (!validateSceneRewrite(scene.durationSec, newDurationSec, qaNote)) {
        throw new WorkbenchError(
          ErrorCode.LLM_OUTPUT_INVALID,
          "Rewrite exceeds the allowed duration tolerance",
          {
            oldDurationSec: scene.durationSec,
            newDurationSec,
            qaNote,
          },
        );
      }

      const scenes = project.storyboard.scenes;
      const oldTotal = scenes.reduce((sum, s) => sum + s.durationSec, 0);
      const newTotal = scenes.reduce(
        (sum, s) =>
          sum + (s.sceneId === sceneId ? newDurationSec : s.durationSec),
        0,
      );
      const regenRequired = compositionRegenRequired(oldTotal, newTotal);

      // `applySceneEdit` clears `audioPath` when narration (or voice)
      // changes — narration is always different after a rewrite, so the
      // audio invalidation happens automatically (Property 10).
      const updatedScene: Scene = applySceneEdit(scene, {
        narration: rewrite.narration,
        durationSec: newDurationSec,
        qaNote,
      });
      const newScenes = scenes.map((s) =>
        s.sceneId === sceneId ? updatedScene : s,
      );
      const storyboard: Storyboard = { scenes: newScenes };

      // Regress downstream stageStatus entries so the UI knows the user
      // must re-run them. We leave upstream entries (topic/brief/
      // storyboard) alone — the rewrite is a storyboard-internal edit,
      // not a regression past storyboard. `composition` is only reset
      // when `regenRequired` (>10% total-duration drift, Property 20);
      // `audio` is always reset because the target scene's mp3 is now
      // stale. `render` is reset whenever audio is.
      const nextStageStatus: StageStatusMap = { ...project.stageStatus };
      if (regenRequired) {
        nextStageStatus.composition = { status: "pending" };
      }
      nextStageStatus.audio = { status: "pending" };
      nextStageStatus.render = { status: "pending" };

      const next = {
        ...project,
        storyboard,
        stageStatus: nextStageStatus,
      };
      await writeProject(next);

      return {
        scene: updatedScene,
        compositionRegenRequired: regenRequired,
      };
    });

    return respondJson(result);
  } catch (e) {
    return respondError(e);
  }
}
