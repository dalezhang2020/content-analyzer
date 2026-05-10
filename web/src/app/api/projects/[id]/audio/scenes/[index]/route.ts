/**
 * Video Creation Workbench — `GET /api/projects/{id}/audio/scenes/{index}`.
 *
 * Streams a single scene's `composition/assets/scene-{index}.mp3` file so an
 * inline `<audio controls src="…/audio/scenes/{index}">` element can play
 * it without hitting the static-file route. Supports HTTP Range so the
 * audio scrubber issues valid 206 responses on seek.
 *
 * Behaviour:
 *   - `index` is validated against `[1, MAX_SCENES]` (integer, digits only).
 *     Anything else → 400 `INVALID_SCENE_INDEX`.
 *   - Missing / empty mp3 file → 404 `AUDIO_NOT_FOUND`.
 *   - Without `Range`: 200 with the full buffer.
 *   - With `Range: bytes=START-END?`: 206 with a slice when satisfiable,
 *     416 with `Content-Range: bytes *\/{size}` when not.
 *   - `Cache-Control: no-store` — the underlying mp3 can be regenerated
 *     any time the audio stage re-runs.
 *
 * The whole file is read into memory with `fs.readFile`; per-scene mp3s
 * are tiny (typically < 500 KB) so a streaming `ReadStream` would add
 * complexity without material benefit.
 */

import { promises as fs } from "node:fs";

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  respondError,
} from "@/lib/workbench/api-helpers";
import { MAX_SCENES, STAGE_DIRS } from "@/lib/workbench/constants";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { resolveProjectFile } from "@/lib/workbench/path-safety";

type Ctx = { params: Promise<{ id: string; index: string }> };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse and validate the `index` path segment. Accepts digit-only strings
 * that resolve to an integer in `[1, MAX_SCENES]`. Throws
 * `WorkbenchError(INVALID_SCENE_INDEX, 400)` for any miss.
 */
function parseSceneIndex(raw: string): number {
  // Reject anything that isn't a pure run of ASCII digits — this rules
  // out `-1`, `1.5`, `1e2`, leading `+`, whitespace, `abc`, and the
  // empty string in a single check.
  if (!/^[0-9]+$/.test(raw)) {
    throw new WorkbenchError(
      ErrorCode.INVALID_SCENE_INDEX,
      "Scene index must be a positive integer",
      { input: raw },
    );
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > MAX_SCENES) {
    throw new WorkbenchError(
      ErrorCode.INVALID_SCENE_INDEX,
      `Scene index must be between 1 and ${MAX_SCENES}`,
      { input: raw, max: MAX_SCENES },
    );
  }
  return n;
}

/**
 * Build a 416 Response with the canonical `Content-Range: bytes *\/{size}`
 * header and an empty body, per RFC 7233 §4.4.
 */
function rangeNotSatisfiable(size: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      "Content-Range": `bytes */${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  try {
    const { index: rawIndex } = await ctx.params;
    const projectId = await requireProjectIdFromParams(ctx.params);
    const n = parseSceneIndex(rawIndex);

    // On Vercel: look up the scene's blob URL in Neon and redirect.
    // Audio files are stored in Vercel Blob, not on the local filesystem.
    const { isLocalEnv } = await import("@/lib/env");
    if (!isLocalEnv()) {
      const { sqlOne } = await import("@/lib/db");
      const row = await sqlOne<{ audio_blob_url: string | null; audio_path: string | null }>`
        SELECT audio_blob_url, audio_path
        FROM content_analyzer.scenes
        WHERE project_id = ${projectId} AND scene_index = ${n}
      `;
      const blobUrl = row?.audio_blob_url ?? (row?.audio_path && (row.audio_path.startsWith("http://") || row.audio_path.startsWith("https://")) ? row.audio_path : null);
      if (!blobUrl) {
        throw new WorkbenchError(
          ErrorCode.AUDIO_NOT_FOUND,
          `Audio file not found for scene ${n}`,
          { index: n },
        );
      }
      return Response.redirect(blobUrl, 302);
    }

    const absPath = resolveProjectFile(
      projectId,
      STAGE_DIRS.COMPOSITION,
      STAGE_DIRS.ASSETS,
      `scene-${n}.mp3`,
    );

    const stat = await fs.stat(absPath).catch(() => null);
    if (stat === null || !stat.isFile() || stat.size === 0) {
      throw new WorkbenchError(
        ErrorCode.AUDIO_NOT_FOUND,
        `Audio file not found for scene ${n}`,
        { index: n },
      );
    }

    const buf = await fs.readFile(absPath);
    const size = buf.length;

    const rangeHeader = req.headers.get("range");
    if (!rangeHeader) {
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(size),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      });
    }

    // Narrowly parse `bytes=START-END?`. Any other Range unit or multi-
    // range syntax (e.g. `bytes=0-100,200-300`, `bytes=-100`) falls into
    // the 416 branch — players only issue single-range seeks.
    const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (!m) {
      return rangeNotSatisfiable(size);
    }
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > end ||
      start >= size ||
      end >= size
    ) {
      return rangeNotSatisfiable(size);
    }

    const slice = buf.subarray(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(slice.length),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return respondError(e);
  }
}
