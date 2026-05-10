/**
 * Video Creation Workbench — individual scene routes.
 *
 *   PATCH  /api/projects/{id}/scenes/{sceneId} → update editable fields.
 *   DELETE /api/projects/{id}/scenes/{sceneId} → remove + reindex.
 *
 * Semantic contract (both verbs):
 *   - `project.stage` MUST be in `{storyboard, composition, audio, render,
 *     qa}` (409 `INVALID_STAGE` otherwise).
 *   - The target `sceneId` MUST exist in `project.storyboard.scenes`
 *     (404 `SCENE_NOT_FOUND` otherwise).
 *
 * PATCH applies `applySceneEdit`, which clears `audioPath` iff narration
 * or voice changed (Property 10). After the edit, `reindex` stamps the
 * array — a no-op for sceneIds that don't move, but it keeps the write
 * path uniform (and is cheap).
 *
 * DELETE enforces a floor of `MIN_SCENES` (3) — removing a scene that
 * would drop the storyboard below the minimum throws
 * `409 STORYBOARD_LIMIT`. The associated `assets/scene-{oldIndex}.mp3`
 * file is intentionally left on disk for MVP; the next audio regeneration
 * pass overwrites any stale files, so the leftover is functionally harmless.
 *
 * Both handlers run inside `withProjectLock` to serialise with concurrent
 * CRUD operations.
 */

import type { NextRequest } from "next/server";

import {
  parseJsonBody,
  requireProjectIdFromParams,
  requireSceneIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { MIN_SCENES } from "@/lib/workbench/constants";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { withProjectLock } from "@/lib/workbench/locks";
import { readProject, writeProject } from "@/lib/workbench/project-store";
import {
  applySceneEdit,
  deleteScene,
  reindex,
} from "@/lib/workbench/scene-reindexer";
import { SceneEditableSchema } from "@/lib/workbench/schemas";
import type { Stage } from "@/lib/workbench/types";

/**
 * Stages during which scenes may be added / edited / deleted. Mirrors the
 * list in the collection route and T35 — earlier stages have no storyboard
 * and `published` is terminal.
 */
const ALLOWED_STAGES: readonly Stage[] = [
  "storyboard",
  "composition",
  "audio",
  "render",
] as const;

function assertStageAllowsSceneCrud(stage: Stage): void {
  if (!ALLOWED_STAGES.includes(stage)) {
    throw new WorkbenchError(
      ErrorCode.INVALID_STAGE,
      "Scene CRUD is only allowed after storyboard generation",
      { currentStage: stage, allowedStages: ALLOWED_STAGES },
    );
  }
}

type Ctx = { params: Promise<{ id: string; sceneId: string }> };

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const sceneId = await requireSceneIdFromParams(ctx.params);
    const patch = await parseJsonBody(req, SceneEditableSchema);

    const updated = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);

      assertStageAllowsSceneCrud(project.stage);

      if (project.storyboard === null) {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Storyboard has not been generated",
          { currentStage: project.stage },
        );
      }

      const scenes = project.storyboard.scenes;
      const idx = scenes.findIndex((s) => s.sceneId === sceneId);
      if (idx === -1) {
        throw new WorkbenchError(
          ErrorCode.SCENE_NOT_FOUND,
          "Scene not found",
          { projectId, sceneId },
        );
      }

      const now = new Date().toISOString();
      const edited = applySceneEdit(scenes[idx], patch, now);

      const nextArray = scenes.slice();
      nextArray[idx] = edited;

      // `sceneId` order is unchanged by a PATCH, so `reindex` is a no-op
      // on `index`. It still normalises `audioPath` for any scene whose
      // position drifted earlier — cheap, idempotent.
      const nextScenes = reindex(nextArray);

      const next = {
        ...project,
        storyboard: { ...project.storyboard, scenes: nextScenes },
      };

      await writeProject(next);

      const persisted = nextScenes.find((s) => s.sceneId === sceneId);
      return persisted ?? edited;
    });

    return respondJson(updated);
  } catch (e) {
    return respondError(e);
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const sceneId = await requireSceneIdFromParams(ctx.params);

    const result = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);

      assertStageAllowsSceneCrud(project.stage);

      if (project.storyboard === null) {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Storyboard has not been generated",
          { currentStage: project.stage },
        );
      }

      const scenes = project.storyboard.scenes;
      const exists = scenes.some((s) => s.sceneId === sceneId);
      if (!exists) {
        throw new WorkbenchError(
          ErrorCode.SCENE_NOT_FOUND,
          "Scene not found",
          { projectId, sceneId },
        );
      }

      if (scenes.length - 1 < MIN_SCENES) {
        throw new WorkbenchError(
          ErrorCode.STORYBOARD_LIMIT,
          `Storyboard must contain at least ${MIN_SCENES} scenes`,
          { currentCount: scenes.length, minScenes: MIN_SCENES },
        );
      }

      // `deleteScene` removes the matching scene and reindexes in one
      // pass. For MVP we intentionally leave the orphaned
      // `assets/scene-{oldIndex}.mp3` on disk — the next audio pass
      // overwrites any stale files, so the leftover is harmless.
      const nextScenes = deleteScene(scenes, sceneId);

      const next = {
        ...project,
        storyboard: { ...project.storyboard, scenes: nextScenes },
      };

      await writeProject(next);
      return { deleted: true, sceneId };
    });

    return respondJson(result);
  } catch (e) {
    return respondError(e);
  }
}
