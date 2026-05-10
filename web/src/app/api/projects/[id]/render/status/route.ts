/**
 * GET /api/projects/{id}/render/status
 *
 * Returns the current RenderJob. On Vercel, also reconciles the sandbox
 * state: if the detached render command finished, downloads the MP4,
 * uploads to Blob, and persists the blob URL on the project.
 */

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { isLocalEnv } from "@/lib/env";
import {
  checkRenderProgress,
  getRenderJob,
} from "@/lib/workbench/sandbox-render";

type RouteContext = {
  params:
    | Record<string, string | string[]>
    | Promise<Record<string, string | string[]>>;
};

// checkRenderProgress can take ~20s when downloading/uploading the MP4.
export const maxDuration = 60;

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const job = isLocalEnv()
      ? await getRenderJob(projectId)
      : await checkRenderProgress(projectId);
    if (!job) {
      return respondJson({ status: "none" }, 200);
    }
    return respondJson(job, 200);
  } catch (e) {
    return respondError(e);
  }
}
