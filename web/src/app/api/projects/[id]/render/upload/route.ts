/**
 * POST /api/projects/{id}/render/upload
 *
 * Upload a locally-rendered MP4 to Vercel Blob and persist the URL on
 * the project. Used by the `workbench-render` Kiro skill after local
 * HyperFrames CLI render completes.
 *
 * Body: raw video/mp4 bytes (Content-Type: video/mp4).
 * Query: none.
 * Response: { videoBlobUrl, sizeBytes }
 *
 * Auth: a shared-secret token in the `x-workbench-render-token` header
 * checked against WORKBENCH_RENDER_TOKEN env. Without the token the
 * endpoint returns 401. The token is only needed when uploading from
 * outside Vercel (i.e. from the Kiro skill on the user's Mac).
 */

import type { NextRequest } from "next/server";
import { put } from "@vercel/blob";

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

// The MP4 upload can be tens of MB — give it a bigger ceiling.
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

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

    // ---- Read body --------------------------------------------------
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.startsWith("video/mp4") && !contentType.startsWith("application/octet-stream")) {
      throw new WorkbenchError(
        ErrorCode.WRITE_FAILED,
        `Unexpected content-type: ${contentType}. Expected video/mp4.`,
      );
    }
    const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
    if (contentLength > MAX_UPLOAD_BYTES) {
      throw new WorkbenchError(
        ErrorCode.WRITE_FAILED,
        `Video exceeds ${MAX_UPLOAD_BYTES} bytes`,
      );
    }
    const arrayBuffer = await req.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    if (buf.byteLength === 0) {
      throw new WorkbenchError(ErrorCode.WRITE_FAILED, "Empty request body");
    }
    if (buf.byteLength > MAX_UPLOAD_BYTES) {
      throw new WorkbenchError(
        ErrorCode.WRITE_FAILED,
        `Video exceeds ${MAX_UPLOAD_BYTES} bytes`,
      );
    }

    // ---- Upload to Vercel Blob -------------------------------------
    const blobPath = `video/${projectId}/output.mp4`;
    const { url: videoBlobUrl } = await put(blobPath, buf, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

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
        sizeBytes: buf.byteLength,
        finishedAt,
      },
      200,
    );
  } catch (e) {
    return respondError(e);
  }
}
