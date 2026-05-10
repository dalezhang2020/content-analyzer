/**
 * Video Creation Workbench — projects collection route.
 *
 *   GET  /api/projects  → list all projects (newest-first `ProjectSummary[]`).
 *   POST /api/projects  → create a new project scaffold.
 *
 * Both handlers funnel errors through `respondError`, which maps
 * `WorkbenchError` / `ZodError` / unknown throwables to the canonical
 * envelope defined in `src/lib/workbench/errors.ts`.
 *
 * Creation flow:
 *   1. Parse body with `CreateProjectInputSchema`.
 *   2. Resolve the HyperFrames template on disk
 *      (`getTemplateSource` → `TEMPLATE_NOT_FOUND` on miss).
 *   3. `createProject` generates an ID, scaffolds the per-project dir tree,
 *      and persists the initial Project JSON.
 *   4. Deep-copy the template into `data/projects/{id}/composition/`.
 *      On copy failure, roll back by best-effort `deleteProject(id)` and
 *      rethrow the original error.
 *   5. Return `201 Created` with the full `Project`.
 */

import type { NextRequest } from "next/server";

import {
  parseJsonBody,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { STAGE_DIRS } from "@/lib/workbench/constants";
import { resolveProjectFile } from "@/lib/workbench/path-safety";
import {
  createProject,
  deleteProject,
  listProjects,
} from "@/lib/workbench/project-store";
import { CreateProjectInputSchema } from "@/lib/workbench/schemas";
import {
  deepCopyTemplate,
  getTemplateSource,
} from "@/lib/workbench/template-manager";

/**
 * List every project on disk as `ProjectSummary[]`, newest-first by
 * `updatedAt`. Returns `[]` when no projects exist (never 404).
 */
export async function GET(): Promise<Response> {
  try {
    const projects = await listProjects();
    return respondJson(projects, 200);
  } catch (e) {
    return respondError(e);
  }
}

/**
 * Create a new project from the request body. Rolls back the filesystem
 * scaffold if the template deep-copy fails, so a failed create never leaves
 * a half-populated project directory behind.
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const input = await parseJsonBody(req, CreateProjectInputSchema);

    // Resolve template BEFORE creating the project so a missing template
    // fails fast without touching the filesystem.
    const templateSource = await getTemplateSource();

    const project = await createProject(input, templateSource);

    try {
      const compositionDir = resolveProjectFile(
        project.projectId,
        STAGE_DIRS.COMPOSITION,
      );
      await deepCopyTemplate(templateSource.sourcePath, compositionDir);
    } catch (copyErr) {
      // Best-effort rollback — swallow cleanup failures so the caller sees
      // the original copy error (the actionable one).
      try {
        await deleteProject(project.projectId);
      } catch {
        // ignore
      }
      throw copyErr;
    }

    return respondJson(project, 201);
  } catch (e) {
    return respondError(e);
  }
}
