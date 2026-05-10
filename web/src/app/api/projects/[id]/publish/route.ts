/**
 * POST /api/projects/[id]/publish
 *
 * Advances a project to the `published` stage after verifying all publish
 * preconditions are met:
 *   1. Current stage must be `render` or `qa` (the only two stages the state
 *      machine allows to transition into `published`).
 *   2. `artifacts.videoPath` must be non-null AND resolve to an on-disk MP4
 *      whose size is strictly greater than zero.
 *
 * When any precondition fails, the handler returns 409 `CANNOT_PUBLISH` with
 * a `details.missing[]` array enumerating every unmet condition so the client
 * can surface them all in a single pass (no need for the user to retry after
 * fixing one issue at a time).
 *
 * Concurrency: every mutation runs under `withProjectLock(projectId)` so
 * concurrent publish / rename / delete calls serialise and fail-fast with
 * 409 `LOCK_BUSY` rather than interleaving.
 *
 * _Requirements: 17.5, 17.6_
 */

import { stat } from "node:fs/promises";
import path from "node:path";

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { fileExists } from "@/lib/workbench/atomic-fs";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { withProjectLock } from "@/lib/workbench/locks";
import { readProject, writeProject } from "@/lib/workbench/project-store";
import { applyTransition } from "@/lib/workbench/state-machine";

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

    const updated = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);
      const missing: string[] = [];

      // Precondition 1: stage must be render or qa. `applyTransition` would
      // also reject an illegal edge, but we collect the failure reason here
      // so the client sees it alongside any video-file issues in a single
      // `details.missing[]` payload.
      if (project.stage !== "render" && project.stage !== "qa") {
        missing.push(
          `stage must be render or qa (current: ${project.stage})`,
        );
      }

      // Precondition 2: artifacts.videoPath must point to an existing,
      // non-empty MP4. `videoPath` is stored as a public URL like
      // "/videos/project-{id}.mp4"; map it to an absolute path under
      // `public/` for the file-existence / size probe.
      if (!project.artifacts.videoPath) {
        missing.push("artifacts.videoPath is null");
      } else {
        const publicPath = project.artifacts.videoPath.startsWith("/")
          ? project.artifacts.videoPath.slice(1)
          : project.artifacts.videoPath;
        const absPath = path.resolve(process.cwd(), "public", publicPath);
        const exists = await fileExists(absPath);
        if (!exists) {
          missing.push("video mp4 file does not exist on disk");
        } else {
          const size = (await stat(absPath)).size;
          if (size === 0) {
            missing.push("video mp4 file is 0 bytes");
          }
        }
      }

      if (missing.length > 0) {
        throw new WorkbenchError(
          ErrorCode.CANNOT_PUBLISH,
          "Cannot publish: preconditions not met",
          { missing },
        );
      }

      // The state machine only carries an explicit `qa → published` edge.
      // Req 17.5 allows publishing directly from `render` as well, so for
      // projects still at `render` we synthesize the intermediate
      // `render → qa` transition atomically inside the same locked write.
      // Both hops are legal edges (`render → qa` is a forward edge in
      // `FORWARD_TRANSITIONS`), and keeping them in one atomic commit
      // preserves the one-mutation-per-publish contract.
      let staged = project;
      if (staged.stage === "render") {
        staged = applyTransition(staged, "qa", {
          reason: "auto-advanced by publish",
        });
      }
      const next = applyTransition(staged, "published");
      await writeProject(next);
      return next;
    });

    return respondJson(updated);
  } catch (e) {
    return respondError(e);
  }
}
