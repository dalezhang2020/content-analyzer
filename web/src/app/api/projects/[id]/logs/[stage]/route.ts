/**
 * Video Creation Workbench — `GET /api/projects/{id}/logs/{stage}`.
 *
 * Returns a tail of the per-stage log file at
 * `data/projects/{id}/logs/{stage}.log`. Used by the workbench UI to
 * display the full failure log when a stage fails (see
 * `LogViewer` popover + `StageFailureBanner`).
 *
 * Query params:
 *   - `tail` (optional, 1–1000). Defaults to `LIMITS.LOG_TAIL_DEFAULT`
 *     (500). Out-of-range values are clamped.
 *
 * Response shape:
 *   - `200 { lines: string[], exists: true, total: number }` — log file
 *     exists; `lines` is the last `tail` non-empty lines and `total` is
 *     the total count of non-empty lines on disk.
 *   - `200 { lines: [], exists: false }` — log file is absent (the
 *     stage hasn't emitted any log yet). Not a 404 — callers typically
 *     open the viewer before any logs exist and we want the empty state
 *     to render cleanly.
 *
 * The `stage` path param must be one of the 8 canonical `STAGES` or the
 * string `"system"` (reserved for the project-level bootstrap log). Any
 * other value is rejected as `400 VALIDATION_FAILED`.
 */

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { LIMITS, STAGE_DIRS, STAGES } from "@/lib/workbench/constants";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { readFileSafe } from "@/lib/workbench/atomic-fs";
import { resolveProjectFile } from "@/lib/workbench/path-safety";
import type { Stage } from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// Allowed stage values
// ---------------------------------------------------------------------------

/**
 * Canonical set of stage names accepted for the log viewer — the 8
 * state-machine stages plus `"system"` for the project bootstrap log.
 */
const VALID_LOG_STAGES: readonly (Stage | "system")[] = [
  ...STAGES,
  "system",
] as const;

function isValidLogStage(s: string): s is Stage | "system" {
  return (VALID_LOG_STAGES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Tail clamping
// ---------------------------------------------------------------------------

/**
 * Upper bound on the `tail` query parameter. The UI should never need
 * more than a few hundred lines at once; 1000 gives us headroom for
 * power users without risking an oversized response.
 */
const TAIL_MAX = 1000;
const TAIL_MIN = 1;

/**
 * Parse the `tail` query parameter. Missing / invalid → default.
 * Otherwise clamped to `[TAIL_MIN, TAIL_MAX]`.
 */
function parseTail(raw: string | null): number {
  if (raw === null) return LIMITS.LOG_TAIL_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return LIMITS.LOG_TAIL_DEFAULT;
  if (parsed < TAIL_MIN) return TAIL_MIN;
  if (parsed > TAIL_MAX) return TAIL_MAX;
  return parsed;
}

// ---------------------------------------------------------------------------
// Route context type (Next.js 16 dynamic APIs)
// ---------------------------------------------------------------------------

type Ctx = { params: Promise<{ id: string; stage: string }> };

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const { stage } = await ctx.params;

    if (!isValidLogStage(stage)) {
      throw new WorkbenchError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid stage",
        { stage, allowed: VALID_LOG_STAGES },
      );
    }

    const url = new URL(req.url);
    const tail = parseTail(url.searchParams.get("tail"));

    const logPath = resolveProjectFile(
      projectId,
      STAGE_DIRS.LOGS,
      `${stage}.log`,
    );

    let content: string;
    try {
      content = await readFileSafe(logPath);
    } catch (e) {
      // `readFileSafe` maps ENOENT to `READ_FAILED` with message/reason
      // `"Not found"`. That's an expected condition for log viewing —
      // the stage may simply not have written anything yet — so surface
      // it as an explicit "empty" response rather than a 500.
      if (
        e instanceof WorkbenchError &&
        e.code === ErrorCode.READ_FAILED &&
        e.details?.reason === "Not found"
      ) {
        return respondJson({ lines: [], exists: false });
      }
      throw e;
    }

    // Split on \n and drop trailing empty lines (from the terminator).
    // The logger always writes one JSON object per line, so each
    // non-empty line is one log entry.
    const allLines = content.split("\n").filter((line) => line.length > 0);
    const tailLines = allLines.slice(-tail);

    return respondJson({
      lines: tailLines,
      exists: true,
      total: allLines.length,
    });
  } catch (e) {
    return respondError(e);
  }
}
