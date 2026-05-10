/**
 * Video Creation Workbench — `POST /api/projects/{id}/composition/sync-template`.
 *
 * Re-syncs the safe subset of the HyperFrames template into an existing
 * project's `composition/` directory: `hyperframes.json`, `package.json`,
 * and `fonts/` are overwritten while `index.html` and `assets/` are left
 * alone (user edits to those are preserved by design — see `template-manager`).
 *
 * Baseline semantics (MVP):
 *   The "baseline" for conflict detection is the template's *current*
 *   `hyperframes.json` at the time of the sync, not a snapshot captured at
 *   project creation time. This means the sync only aborts when the
 *   project's local `composition/hyperframes.json` has diverged from what
 *   the template ships today — it does NOT detect drift introduced by a
 *   template upgrade. A stricter baseline (persisted at creation) is noted
 *   in design OD and deferred.
 *
 *   On conflict `template-manager::syncTemplate` throws
 *   `WorkbenchError(TEMPLATE_CONFLICT, …, { conflicts })` which the error
 *   helper maps to HTTP 409. On success, the project's `templateSource.version`
 *   is refreshed to match the freshly-resolved template.
 *
 * The whole flow runs under `withProjectLock` so concurrent sync calls
 * against the same project fail fast with 409 `LOCK_BUSY`.
 */

import path from "node:path";

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { readFileSafe } from "@/lib/workbench/atomic-fs";
import { STAGE_DIRS } from "@/lib/workbench/constants";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { withProjectLock } from "@/lib/workbench/locks";
import { resolveProjectFile } from "@/lib/workbench/path-safety";
import { readProject, writeProject } from "@/lib/workbench/project-store";
import {
  getTemplateSource,
  syncTemplate,
} from "@/lib/workbench/template-manager";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);

    const result = await withProjectLock(projectId, async () => {
      const project = await readProject(projectId);
      const templateSource = await getTemplateSource();

      // MVP baseline: re-read the template's current `hyperframes.json`
      // and treat it as the baseline for conflict detection. See the
      // module header for why this is a simplification vs. a snapshot
      // captured at project creation.
      const baselinePath = path.join(
        templateSource.sourcePath,
        "hyperframes.json",
      );
      let baseline: Record<string, unknown>;
      try {
        const raw = await readFileSafe(baselinePath);
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") {
          throw new Error("hyperframes.json is not a JSON object");
        }
        baseline = parsed as Record<string, unknown>;
      } catch (e) {
        throw new WorkbenchError(
          ErrorCode.TEMPLATE_NOT_FOUND,
          "Failed to read template hyperframes.json",
          {
            path: baselinePath,
            reason: e instanceof Error ? e.message : String(e),
          },
        );
      }

      const compositionDir = resolveProjectFile(
        projectId,
        STAGE_DIRS.COMPOSITION,
      );
      await syncTemplate(templateSource.sourcePath, compositionDir, baseline);

      // Sync succeeded — bump `templateSource.version` so the project
      // records which template revision it now carries.
      const next = {
        ...project,
        templateSource: {
          ...project.templateSource,
          version: templateSource.version,
        },
      };
      await writeProject(next);
      return next;
    });

    return respondJson(result);
  } catch (e) {
    return respondError(e);
  }
}
