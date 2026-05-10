/**
 * Video Creation Workbench — manual stage regression.
 *
 *   POST /api/projects/{id}/regress
 *
 * Body: `{ target: Stage, reason?: string }`. Explicitly regresses the
 * project to any earlier stage — including from `published` —
 * bypassing the narrow `qa → {storyboard|composition|audio}` edges the
 * automatic pipeline enforces.
 *
 * Why this exists: `applyTransition` is the strict guard for the
 * automatic pipeline and intentionally rejects sideways / forward /
 * terminal-source edges. When the UI needs to hand a user back the
 * ability to retry an earlier stage (e.g. `INVALID_STAGE: Audio
 * generation requires stage=composition` on a `published` project),
 * `regressToStage` is the loose "manual override" path that resets
 * `stage` + every downstream `stageStatus` entry to `pending` and
 * appends a history entry so the audit trail captures the jump.
 *
 * Server-side flow:
 *   1. Validate `projectId` (regex).
 *   2. Parse `{ target, reason? }` via `RegressInputSchema`.
 *   3. `withProjectLock(projectId)` ─────────────────────────────────
 *        - `readProject(projectId)`
 *        - `regressToStage(project, target, { reason })`
 *        - `writeProject(next)`
 *        - re-read so the returned project carries the refreshed
 *          `updatedAt` stamped by `writeProject`.
 *      ────────────────────────────────────────────────────────────
 *   4. Return the persisted Project with 200.
 *
 * Error mapping via `respondError`:
 *   - Invalid projectId → 400 `INVALID_PROJECT_ID`
 *   - Body validation → 400 `VALIDATION_FAILED`
 *   - Missing project → 404 `PROJECT_NOT_FOUND`
 *   - Regression to same-or-later stage → 409 `INVALID_TRANSITION`
 *   - Lock held → 409 `LOCK_BUSY`
 *   - Anything else → 500 `UNKNOWN`
 *
 * _Requirements: 1.4, 1.5_
 */

import type { NextRequest } from "next/server";

import {
  parseJsonBody,
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { withProjectLock } from "@/lib/workbench/locks";
import { readProject, writeProject } from "@/lib/workbench/project-store";
import { RegressInputSchema } from "@/lib/workbench/schemas";
import { regressToStage } from "@/lib/workbench/state-machine";

type Ctx = { params: Promise<{ id: string }> };

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const { target, reason } = await parseJsonBody(req, RegressInputSchema);

    const persisted = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);
      const next = regressToStage(project, target, { reason });
      await writeProject(next);
      // Re-read so the returned project carries the refreshed `updatedAt`
      // stamped by `writeProject`.
      return readProject(projectId);
    });

    return respondJson(persisted);
  } catch (e) {
    return respondError(e);
  }
}
