/**
 * Video Creation Workbench — scene collection route.
 *
 *   POST /api/projects/{id}/scenes → append a new Scene to the storyboard.
 *
 * Semantic contract:
 *   - `project.stage` MUST be in `{storyboard, composition, audio, render,
 *     qa}`. Earlier stages (`topic`, `brief`) have no storyboard yet;
 *     `published` is terminal. Violations surface as `409 INVALID_STAGE`.
 *   - `project.storyboard` MUST exist. This is a belt-and-braces check on
 *     the stage-guard invariant (if stage is `storyboard+`, storyboard
 *     should already be populated by its generator).
 *   - Scene count + 1 MUST NOT exceed `MAX_SCENES` (20), else
 *     `409 STORYBOARD_LIMIT`.
 *
 * The append runs inside `withProjectLock` so concurrent CRUD operations
 * against the same project serialise (fail-fast `LOCK_BUSY` → HTTP 409).
 * The new scene lands at the end of the array; `reindex` then stamps it
 * with `index = scenes.length` (1-based, contiguous).
 *
 * _Requirements: 3.1, 3.3–3.9, 5.8–5.10_
 */

import { randomBytes } from "node:crypto";

import type { NextRequest } from "next/server";

import {
  parseJsonBody,
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { DEFAULT_VOICE, MAX_SCENES } from "@/lib/workbench/constants";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { withProjectLock } from "@/lib/workbench/locks";
import { readProject, writeProject } from "@/lib/workbench/project-store";
import { reindex } from "@/lib/workbench/scene-reindexer";
import { SceneCreateInputSchema } from "@/lib/workbench/schemas";
import type { Scene, Stage } from "@/lib/workbench/types";

/**
 * Stages during which scenes may be added / edited / deleted. Mirrors the
 * list in T35 — earlier stages have no storyboard and `published` is
 * terminal.
 */
const ALLOWED_STAGES: readonly Stage[] = [
  "storyboard",
  "composition",
  "audio",
  "render",
  "qa",
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

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const input = await parseJsonBody(req, SceneCreateInputSchema);

    const created = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);

      assertStageAllowsSceneCrud(project.stage);

      if (project.storyboard === null) {
        // Defensive: stage guard should have prevented this. Surfacing as
        // INVALID_STAGE keeps the HTTP status consistent with the guard.
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Storyboard has not been generated",
          { currentStage: project.stage },
        );
      }

      const current = project.storyboard.scenes;
      if (current.length + 1 > MAX_SCENES) {
        throw new WorkbenchError(
          ErrorCode.STORYBOARD_LIMIT,
          `Storyboard may contain at most ${MAX_SCENES} scenes`,
          { currentCount: current.length, maxScenes: MAX_SCENES },
        );
      }

      // 4 random bytes → 8 lowercase hex chars matching REGEX.SCENE_ID.
      const sceneId = `sc_${randomBytes(4).toString("hex")}`;
      const now = new Date().toISOString();

      // `index` is a placeholder; `reindex` below stamps the final value.
      const appended: Scene = {
        sceneId,
        index: current.length + 1,
        title: input.title,
        narration: input.narration,
        durationSec: input.durationSec,
        voice: input.voice ?? DEFAULT_VOICE,
        audioPath: null,
        qaNote: "",
        updatedAt: now,
      };

      const nextScenes = reindex([...current, appended]);
      const next = {
        ...project,
        storyboard: { ...project.storyboard, scenes: nextScenes },
      };

      await writeProject(next);

      // Return the canonical reindexed scene (its `index` is final here).
      const persisted = nextScenes.find((s) => s.sceneId === sceneId);
      return persisted ?? appended;
    });

    return respondJson(created, 201);
  } catch (e) {
    return respondError(e);
  }
}
