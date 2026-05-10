/**
 * POST /api/projects/{id}/render/upload
 *
 * Receive metadata for a locally-rendered MP4 that was uploaded DIRECTLY
 * to Vercel Blob by the workbench-render Kiro skill (using the
 * @vercel/blob SDK with BLOB_READ_WRITE_TOKEN). This route just writes
 * the video URL to Neon — it does NOT accept the actual bytes.
 *
 * Why: Vercel serverless functions have a 4.5 MB body limit that's hard
 * to raise. MP4s can be 10-50 MB. The solution is to have the CLI
 * upload straight to Blob storage using its read-write token (which it
 * already has in ~/.kiro/settings/workbench-render.env), then POST here
 * with just the URL + size.
 *
 * Body (application/json):
 *   { videoBlobUrl: string, sizeBytes?: number }
 *
 * Auth: x-workbench-render-token header (shared secret).
 */

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { sql, sqlOne } from "@/lib/db";

type RouteContext = {
  params:
    | Record<string, string | string[]>
    | Promise<Record<string, string | string[]>>;
};

export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  try {
    // ---- Auth -------------------------------------------------------
    const expectedToken = process.env.WORKBENCH_RENDER_TOKEN;
    if (!expectedToken) {
      throw new WorkbenchError(
        ErrorCode.WRITE_FAILED,
        "WORKBENCH_RENDER_TOKEN is not configured on the server",
      );
    }
    const providedToken = req.headers.get("x-workbench-render-token");
    if (providedToken !== expectedToken) {
      return new Response(
        JSON.stringify({
          error: { code: "UNAUTHORIZED", message: "Invalid or missing upload token" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    const projectId = await requireProjectIdFromParams(ctx.params);

    // Make sure the project exists.
    const projectRow = await sqlOne<{ project_id: string }>`
      SELECT project_id FROM content_analyzer.projects WHERE project_id = ${projectId}
    `;
    if (!projectRow) {
      throw new WorkbenchError(ErrorCode.PROJECT_NOT_FOUND, "Project not found", {
        projectId,
      });
    }

    // ---- Parse body -------------------------------------------------
    let body: { videoBlobUrl?: string; sizeBytes?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      throw new WorkbenchError(
        ErrorCode.WRITE_FAILED,
        "Invalid JSON body",
      );
    }

    const videoBlobUrl = body.videoBlobUrl;
    if (!videoBlobUrl || typeof videoBlobUrl !== "string") {
      throw new WorkbenchError(
        ErrorCode.WRITE_FAILED,
        "videoBlobUrl is required",
      );
    }
    if (!videoBlobUrl.startsWith("https://") || !videoBlobUrl.includes(".blob.vercel-storage.com")) {
      throw new WorkbenchError(
        ErrorCode.WRITE_FAILED,
        "videoBlobUrl must be a Vercel Blob URL",
        { provided: videoBlobUrl },
      );
    }

    // ---- Persist to Neon -------------------------------------------
    const finishedAt = new Date().toISOString();
    await sql`
      UPDATE content_analyzer.projects
      SET video_blob_url = ${videoBlobUrl},
          artifacts = jsonb_set(
            COALESCE(artifacts, '{}'::jsonb),
            '{videoPath}',
            to_jsonb(${videoBlobUrl}::text)
          ),
          stage = 'render',
          stage_status = jsonb_set(
            jsonb_set(
              jsonb_set(
                COALESCE(stage_status, '{}'::jsonb),
                '{render,status}',
                '"succeeded"'
              ),
              '{render,finishedAt}',
              to_jsonb(${finishedAt}::text)
            ),
            '{render,attempts}',
            to_jsonb(COALESCE((stage_status->'render'->>'attempts')::int, 0) + 1)
          ),
          updated_at = NOW()
      WHERE project_id = ${projectId}
    `;

    return respondJson(
      {
        videoBlobUrl,
        sizeBytes: body.sizeBytes ?? null,
        finishedAt,
      },
      200,
    );
  } catch (e) {
    return respondError(e);
  }
}
