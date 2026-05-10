/**
 * Video Creation Workbench — atomic bulk-voice update.
 *
 *   POST /api/projects/{id}/scenes/bulk-voice
 *
 * Body: `{ voice: string }` (Azure TTS voice name). Applies the voice
 * uniformly across every scene in `project.storyboard.scenes` inside a
 * single `withProjectLock` acquisition and a single atomic
 * `writeProject`. Replaces the client-side fan-out of N PATCHes that
 * raced the per-project lock and could only partially succeed.
 *
 * Stage policy (intentionally looser than the per-scene PATCH route):
 *   - `project.storyboard` MUST be present — else `INVALID_STAGE` (409).
 *     Topic + brief stages have no storyboard, so this guard also covers
 *     the "no content to update" case without a separate check.
 *   - ANY stage from `storyboard` onwards is allowed, including
 *     `published`. Voice change is treated as a corrective edit, not a
 *     content-CRUD op: it does not mutate narration, title, or
 *     duration, so the stage DAG is not invalidated by running it on a
 *     published project. (The per-scene PATCH route still rejects
 *     `published` — see its `ALLOWED_STAGES` — because narration /
 *     duration edits DO require a stage regression.)
 *
 * Server-side flow:
 *   1. `readProject(projectId)`
 *   2. Assert `storyboard !== null`.
 *   3. For every scene, call `applySceneEdit(scene, { voice }, now)` —
 *      this clears `audioPath` iff the voice actually changed
 *      (Property 10), so subsequent "生成全部 Audio" regenerates only
 *      the scenes that drifted.
 *   4. `reindex(nextScenes)` — a no-op for `sceneId` order, but it
 *      keeps the write path uniform with the rest of the scene CRUD
 *      routes (and normalises any canonical `audioPath` that might
 *      have slipped out of sync).
 *   5. `writeProject({ ...project, storyboard: { ...scenes: next } })`
 *
 * Error mapping is via `respondError` (the canonical envelope):
 *   - Invalid project id        → 400 `INVALID_PROJECT_ID`
 *   - Body validation failure   → 400 `VALIDATION_FAILED`
 *   - Missing storyboard        → 409 `INVALID_STAGE`
 *   - Project missing from disk → 404 `PROJECT_NOT_FOUND`
 *   - Lock held by another op   → 409 `LOCK_BUSY`
 *   - Anything else             → 500 `UNKNOWN`
 */

import type { NextRequest } from "next/server";

import {
  parseJsonBody,
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { withProjectLock } from "@/lib/workbench/locks";
import { readProject, writeProject } from "@/lib/workbench/project-store";
import { applySceneEdit, reindex } from "@/lib/workbench/scene-reindexer";
import { BulkSceneVoiceSchema } from "@/lib/workbench/schemas";

type Ctx = { params: Promise<{ id: string }> };

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const { voice } = await parseJsonBody(req, BulkSceneVoiceSchema);

    const result = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);

      // Stage policy: storyboard must exist. This subsumes the
      // "cannot edit before storyboard generation" check — topic and
      // brief stages by definition have `storyboard === null`. Every
      // stage from `storyboard` through `published` is allowed.
      if (project.storyboard === null) {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Cannot bulk update voice: storyboard is not present",
          { currentStage: project.stage },
        );
      }

      const now = new Date().toISOString();
      const nextScenesRaw = project.storyboard.scenes.map((scene) =>
        applySceneEdit(scene, { voice }, now),
      );

      // `reindex` is a no-op for ordering here (no insert/delete/move),
      // but it's cheap and keeps every scene-mutation code path uniform
      // with the rest of the CRUD routes.
      const nextScenes = reindex(nextScenesRaw);

      const next = {
        ...project,
        storyboard: { ...project.storyboard, scenes: nextScenes },
      };

      await writeProject(next);

      // Re-read so the returned project carries the refreshed
      // `updatedAt` that `writeProject` stamps on the stored JSON.
      const persisted = await readProject(projectId);
      return { project: persisted, updatedCount: nextScenes.length };
    });

    return respondJson(result);
  } catch (e) {
    return respondError(e);
  }
}
