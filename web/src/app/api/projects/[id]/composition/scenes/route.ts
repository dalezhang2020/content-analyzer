/**
 * Video Creation Workbench — `GET /api/projects/{id}/composition/scenes`.
 *
 * Lists the on-disk status of every per-scene sub-composition file for
 * the HTML tab's scene grid. The HTML tab is stage-gated to ≥`composition`,
 * but generation is streamed per-scene — this endpoint lets the UI show
 * which scenes have already produced a sub-composition HTML without
 * waiting for the full composition run to finish.
 *
 * Behaviour:
 *   - `project.storyboard?.scenes ?? []` is the source of truth for which
 *     scenes to enumerate. A missing storyboard (freshly created project,
 *     or storyboard never generated) returns `{ scenes: [] }`.
 *   - For each scene the expected relative path is
 *     `compositions/{compositionId}.html` under the project's `composition`
 *     dir. `resolveProjectFile` funnels the join through
 *     `assertUnderDataDir`, so path traversal on the project id or the
 *     derived relative path is caught before any `fs.stat` call.
 *   - `fs.stat` is wrapped in `.catch(() => null)` — ENOENT and any other
 *     IO error count as "file missing". A race where the file vanishes
 *     between `stat` and the response serialisation therefore degrades to
 *     `exists: false` rather than a 500.
 *   - `updatedAt` is omitted when the file is missing (see `exists=false`),
 *     per the task spec; present as an ISO string derived from `mtimeMs`
 *     otherwise.
 *
 * Error mapping:
 *   - Invalid project id → 400 `INVALID_PROJECT_ID` (via the helper).
 *   - Missing project JSON → 404 `PROJECT_NOT_FOUND` (via `readProject`).
 *   - Any other failure → 500 via `respondError` / `respondWithError`.
 */

import { promises as fs } from "node:fs";

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  respondError,
} from "@/lib/workbench/api-helpers";
import {
  sceneCompositionId,
  sceneCompositionPath,
} from "@/lib/workbench/ai-generator";
import { STAGE_DIRS } from "@/lib/workbench/constants";
import { sql, isNeonConfigured } from "@/lib/db";
import { resolveProjectFile } from "@/lib/workbench/path-safety";
import { readProject } from "@/lib/workbench/project-store";

type Ctx = { params: Promise<{ id: string }> };

interface SceneCompositionStatus {
  sceneId: string;
  index: number;
  title: string;
  compositionId: string;
  relPath: string;
  exists: boolean;
  size: number;
  updatedAt?: string;
}

export async function GET(
  _req: NextRequest | Request,
  ctx: Ctx,
): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const project = await readProject(projectId);
    const scenes = project.storyboard?.scenes ?? [];

    // Phase 3: if Neon has html_content, use that to determine "exists"
    if (isNeonConfigured()) {
      try {
        const rows = await sql<{
          scene_id: string;
          html_content: string | null;
          updated_at: string;
        }>`
          SELECT scene_id, html_content, updated_at::text AS updated_at
          FROM content_analyzer.scenes
          WHERE project_id = ${projectId}
        `;
        const neonMap = new Map(rows.map((r) => [r.scene_id, r]));

        const entries: SceneCompositionStatus[] = scenes.map((scene) => {
          const compositionId = sceneCompositionId(scene);
          const relPath = sceneCompositionPath(scene);
          const neonRow = neonMap.get(scene.sceneId);
          const exists = Boolean(neonRow?.html_content);
          return {
            sceneId: scene.sceneId,
            index: scene.index,
            title: scene.title,
            compositionId,
            relPath,
            exists,
            size: exists && neonRow?.html_content ? neonRow.html_content.length : 0,
            updatedAt: exists && neonRow ? neonRow.updated_at : undefined,
          };
        });

        return Response.json(
          { scenes: entries },
          { status: 200, headers: { "Cache-Control": "no-store" } },
        );
      } catch (err) {
        console.warn("[composition/scenes] Neon read failed, falling back to FS:", err instanceof Error ? err.message : err);
      }
    }

    // Local FS fallback
    const entries: SceneCompositionStatus[] = await Promise.all(
      scenes.map(async (scene) => {
        const compositionId = sceneCompositionId(scene);
        const relPath = sceneCompositionPath(scene);
        const absPath = resolveProjectFile(
          projectId,
          STAGE_DIRS.COMPOSITION,
          relPath,
        );

        const stat = await fs.stat(absPath).catch(() => null);
        const exists = stat !== null && stat.isFile();

        const entry: SceneCompositionStatus = {
          sceneId: scene.sceneId,
          index: scene.index,
          title: scene.title,
          compositionId,
          relPath,
          exists,
          size: exists && stat ? stat.size : 0,
        };
        if (exists && stat) {
          entry.updatedAt = new Date(stat.mtimeMs).toISOString();
        }
        return entry;
      }),
    );

    return Response.json(
      { scenes: entries },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (e) {
    return respondError(e);
  }
}
