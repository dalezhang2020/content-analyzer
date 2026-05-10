/**
 * Video Creation Workbench — `POST /api/projects/{id}/scenes/{sceneId}/tts`.
 *
 * Regenerate TTS audio for a single scene. Always runs with `force`
 * semantics — the user explicitly asked for the re-synthesis — so any
 * pre-existing mp3 at `composition/assets/scene-{index}.mp3` is
 * overwritten.
 *
 * Pipeline:
 *   1. Validate path params via `requireProjectIdFromParams` /
 *      `requireSceneIdFromParams`.
 *   2. Acquire the per-project lock (fail-fast `LOCK_BUSY` → 409).
 *   3. Read the project and assert a storyboard exists (else 409
 *      `INVALID_STAGE`).
 *   4. `synthesizeOne(project, sceneId)` — surfaces `SCENE_NOT_FOUND` 404,
 *      `TTS_TIMEOUT` 504, `TTS_PROVIDER_UNCONFIGURED` 500, and any write / HTTP
 *      error (502-ish via `respondError`).
 *   5. Persist the updated scene back into `project.storyboard.scenes`,
 *      leaving every other scene untouched, and `writeProject`.
 *   6. Return the updated Scene as JSON.
 *
 * Stage + stageStatus are not touched: this route re-synthesises an
 * individual asset without regressing the pipeline. The caller remains
 * responsible for re-running downstream stages if they were already
 * finished.
 *
 * _Requirements: 9.1, 9.4, 9.5, 9.6, 9.9_
 */

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  requireSceneIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { withProjectLock } from "@/lib/workbench/locks";
import { readProject, writeProject } from "@/lib/workbench/project-store";
import { synthesizeOne } from "@/lib/workbench/tts-service";
import type { Storyboard } from "@/lib/workbench/types";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; sceneId: string }> },
): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const sceneId = await requireSceneIdFromParams(ctx.params);

    const updatedScene = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);
      if (!project.storyboard) {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Storyboard not present — cannot synthesize audio",
          { currentStage: project.stage },
        );
      }

      // `synthesizeOne` handles SCENE_NOT_FOUND / TTS_PROVIDER_UNCONFIGURED /
      // TTS_TIMEOUT itself; anything else (write failures, unexpected
      // HTTP errors) bubbles up to `respondError` below.
      const scene = await synthesizeOne(project, sceneId);

      const newScenes = project.storyboard.scenes.map((s) =>
        s.sceneId === sceneId ? scene : s,
      );
      const storyboard: Storyboard = { scenes: newScenes };
      const next = { ...project, storyboard };
      await writeProject(next);
      return scene;
    });

    return respondJson(updatedScene);
  } catch (e) {
    return respondError(e);
  }
}
