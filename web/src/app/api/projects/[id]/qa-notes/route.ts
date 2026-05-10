/**
 * Video Creation Workbench — QA notes routes.
 *
 * `GET  /api/projects/{id}/qa-notes` — list every persisted `QaNote`.
 * `POST /api/projects/{id}/qa-notes` — append a new project- or scene-level
 *   note. `sceneId` is optional: `null` / omitted = project-level; a
 *   provided value must satisfy `REGEX.SCENE_ID` (schema-enforced).
 *
 * Writes funnel through `withProjectLock` so concurrent POSTs against the
 * same project serialise (fail-fast `LOCK_BUSY` → HTTP 409). The append
 * path reads the current project under the lock, derives a `qan_{8hex}`
 * `noteId`, and persists via `writeProject`.
 *
 * _Requirements: 12.10_
 */

import { randomBytes } from "node:crypto";

import type { NextRequest } from "next/server";

import {
  parseJsonBody,
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { withProjectLock } from "@/lib/workbench/locks";
import { readProject, writeProject } from "@/lib/workbench/project-store";
import { QaNoteInputSchema } from "@/lib/workbench/schemas";
import type { QaNote } from "@/lib/workbench/types";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const project = await readProject(projectId);
    return respondJson(project.qaNotes);
  } catch (e) {
    return respondError(e);
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const input = await parseJsonBody(req, QaNoteInputSchema);

    const note = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);
      // 4 random bytes → 8 lowercase hex chars, matching REGEX.QA_NOTE_ID
      // (`^qan_[a-z0-9]{8}$`).
      const noteId = `qan_${randomBytes(4).toString("hex")}`;
      const created: QaNote = {
        noteId,
        sceneId: input.sceneId ?? null,
        text: input.text,
        author: "local",
        createdAt: new Date().toISOString(),
      };
      const next = { ...project, qaNotes: [...project.qaNotes, created] };
      await writeProject(next);
      return created;
    });

    return respondJson(note, 201);
  } catch (e) {
    return respondError(e);
  }
}
