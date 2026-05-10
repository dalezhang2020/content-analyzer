/**
 * Video Creation Workbench — `GET /api/projects/{id}/composition/html`.
 *
 * Returns the raw `composition/index.html` bytes for the HTML tab's
 * read-only source preview. Served as `text/html; charset=utf-8` so a
 * browser hitting the URL directly can preview the composition without
 * going through a separate static-file route.
 *
 * Error mapping:
 *   - Invalid project id → 400 `INVALID_PROJECT_ID` (via the helper).
 *   - Missing / unreadable `index.html` → 500 `READ_FAILED` (the HTML tab
 *     is stage-gated to ≥`composition`, so a missing file at that point
 *     is a data-integrity bug worth surfacing).
 *
 * The payload is whatever the underlying file contains — the composition
 * pipeline already enforces sane HTML sizes via the repair loop, so no
 * additional truncation is applied here.
 *
 * _Requirements: 12.5_
 */

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  respondError,
} from "@/lib/workbench/api-helpers";
import { readCompositionHtml } from "@/lib/workbench/project-store";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(
  _req: NextRequest,
  ctx: Ctx,
): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const html = await readCompositionHtml(projectId);

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return respondError(e);
  }
}
