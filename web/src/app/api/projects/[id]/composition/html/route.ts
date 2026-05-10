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
 */

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  respondError,
} from "@/lib/workbench/api-helpers";
import { sql, isNeonConfigured } from "@/lib/db";
import { readCompositionHtml } from "@/lib/workbench/project-store";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(
  _req: NextRequest,
  ctx: Ctx,
): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);

    let html: string | null = null;

    // Phase 3: try Neon first
    if (isNeonConfigured()) {
      try {
        const rows = await sql<{ index_html_content: string | null }>`
          SELECT index_html_content
          FROM content_analyzer.projects
          WHERE project_id = ${projectId}
        `;
        if (rows[0]?.index_html_content) {
          html = rows[0].index_html_content;
        }
      } catch (err) {
        console.warn("[composition/html] Neon read failed, falling back to FS:", err instanceof Error ? err.message : err);
      }
    }

    // Local FS fallback
    if (!html) {
      html = await readCompositionHtml(projectId);
    }

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
