/**
 * Video Creation Workbench — `GET/PATCH/DELETE /api/projects/{id}`.
 *
 * Per-project CRUD for the dashboard and project header:
 *   - `GET`     returns the full `Project` aggregate.
 *   - `PATCH`   accepts a subset of `{ title, topic }` and persists it
 *               atomically. `topic` edits are only permitted while the
 *               project is still at `stage: "topic"` (before brief
 *               generation) so downstream artefacts never drift from the
 *               topic they were derived from.
 *   - `DELETE`  removes the project JSON, its per-project directory, and
 *               any published MP4 assets. Partial failures surface as
 *               `500 PARTIAL_DELETE` with the per-path reasons.
 *
 * Every mutating method runs inside `withProjectLock` so concurrent
 * PATCH / DELETE / stage transitions on the same `projectId` are
 * serialised (fail-fast with `409 LOCK_BUSY`).
 *
 * _Requirements: 2.9, 2.10, 2.12, 8.6, 8.10, 11.8_
 */

import { z } from "zod";

import {
  parseJsonBody,
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { CONTROL_CHAR_REGEX, LIMITS } from "@/lib/workbench/constants";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { withProjectLock } from "@/lib/workbench/locks";
import {
  deleteProject,
  readProject,
  writeProject,
} from "@/lib/workbench/project-store";

// ---------------------------------------------------------------------------
// Inline PATCH body schema
// ---------------------------------------------------------------------------

/**
 * Local mirror of `safeStr` from `./schemas.ts`. Inlined here so this
 * route doesn't leak a new exported schema into the shared module for an
 * MVP-only shape. Trims whitespace, enforces length bounds, then rejects
 * ASCII control characters (same pattern as every other workbench body).
 */
const safeTrimmed = (maxLen: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maxLen)
    .refine(
      (s) => !CONTROL_CHAR_REGEX.test(s),
      "Contains control characters",
    );

/**
 * Body schema for `PATCH /api/projects/{id}`.
 *
 * Both fields are optional — callers may update title, topic, or both in
 * a single request. Empty bodies are accepted (a no-op PATCH returns the
 * project with a refreshed `updatedAt`, which the `project-store` writer
 * applies unconditionally).
 *
 * `topic` edits are gated at runtime against `project.stage` (see
 * `PATCH` handler below) — this schema only enforces shape.
 *
 * _Requirements: 2.9, 16.1, 16.3_
 */
const PatchBodySchema = z.object({
  title: safeTrimmed(LIMITS.TITLE_MAX).optional(),
  topic: safeTrimmed(LIMITS.TOPIC_MAX).optional(),
});

// ---------------------------------------------------------------------------
// Route context type (Next.js 16 dynamic APIs)
// ---------------------------------------------------------------------------

type Ctx = { params: Promise<{ id: string }> };

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

/**
 * `GET /api/projects/{id}` → `200 Project`.
 *
 * Errors:
 *   - `400 INVALID_PROJECT_ID`        — id fails the `REGEX.PROJECT_ID` check.
 *   - `404 PROJECT_NOT_FOUND`         — JSON file is missing.
 *   - `409 SCHEMA_VERSION_MISMATCH`   — on-disk `schemaVersion !== 1`.
 *   - `500 READ_FAILED`               — corrupt JSON or schema validation
 *                                       failure (zod issues in `details`).
 *
 * _Requirements: 2.9, 2.10_
 */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const project = await readProject(projectId);
    return respondJson(project);
  } catch (e) {
    return respondError(e);
  }
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

/**
 * `PATCH /api/projects/{id}` — update `title` and/or `topic`.
 *
 * Semantic guard:
 *   - `topic` MAY only change while `stage === "topic"`. Once the brief
 *     stage has produced downstream artefacts, a topic swap would leave
 *     the brief / storyboard / composition referring to content the user
 *     no longer wants. We surface this as `409 INVALID_STAGE` with
 *     `details.currentStage` so the client can explain the block.
 *
 * `title` has no such gating — titles are display metadata only and can
 * be renamed at any stage.
 *
 * The entire mutation runs inside `withProjectLock(projectId, …)` so a
 * concurrent PATCH / DELETE / stage transition on the same project
 * fails fast with `409 LOCK_BUSY`.
 *
 * _Requirements: 2.9, 1.11, 16.1, 16.3_
 */
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const body = await parseJsonBody(req, PatchBodySchema);

    const updated = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);

      if (body.topic !== undefined && project.stage !== "topic") {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Cannot change topic after brief generation",
          { currentStage: project.stage },
        );
      }

      // Apply only the fields the client sent. `writeProject` refreshes
      // `updatedAt` unconditionally, so even an effective-no-op PATCH
      // still advances the timestamp (matches Property 6 — monotonic).
      const next = {
        ...project,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.topic !== undefined ? { topic: body.topic } : {}),
      };

      await writeProject(next);
      // Re-read so the response reflects the exact `updatedAt` persisted
      // by `writeProject` (it mutates the payload before write).
      return readProject(projectId);
    });

    return respondJson(updated);
  } catch (e) {
    return respondError(e);
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

/**
 * `DELETE /api/projects/{id}` — remove every filesystem resource owned
 * by the project.
 *
 * `deleteProject` returns a `DeleteReport` with `succeeded` / `failed`
 * arrays:
 *   - All paths removed (or absent) → `200` with the report.
 *   - Any `failed` entries → `500 PARTIAL_DELETE` with
 *     `{ succeeded, failed }` in `details` so the caller can retry or
 *     clean up manually.
 *
 * The delete runs inside `withProjectLock` to serialise with other
 * mutating operations on the same project.
 *
 * _Requirements: 2.12, 8.10, 11.8_
 */
export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);

    const report = await withProjectLock(projectId, async () => {
      return deleteProject(projectId);
    });

    if (report.failed.length > 0) {
      throw new WorkbenchError(
        ErrorCode.PARTIAL_DELETE,
        "Some files could not be removed",
        { succeeded: report.succeeded, failed: report.failed },
      );
    }

    return respondJson(report);
  } catch (e) {
    return respondError(e);
  }
}
