/**
 * Video Creation Workbench — `GET /api/projects/{id}/render/stream`.
 *
 * Server-Sent Events endpoint that proxies `render-service`'s
 * `subscribeRender(projectId)` async iterable to the client.
 *
 * Behavior:
 *   - 409 `NO_RENDER` when no ActiveRender exists for `projectId`.
 *   - Otherwise: a streaming `Response` with
 *     `Content-Type: text/event-stream`, `Cache-Control: no-cache,
 *     no-transform`, `Connection: keep-alive`. Each `RenderEvent` is
 *     serialised as a single SSE frame of the form
 *
 *     ```
 *     event: <type>
 *     data: <json>
 *
 *     ```
 *
 *     where `<type>` is the discriminator (`stage` | `line` | `heartbeat`
 *     | `error`) and `<json>` is the full event object.
 *   - The stream closes naturally after the iterator yields the terminal
 *     `stage: done` / `stage: failed` event (see render-service's
 *     `subscribeRenderImpl`). Any thrown error is surfaced as a trailing
 *     `event: error` frame followed by close — we never leak an unhandled
 *     rejection into the Response.
 *
 * _Requirements: 10.5, 10.7, 10.11_
 */

import type { NextRequest } from "next/server";

import {
  requireProjectIdFromParams,
  respondError,
} from "@/lib/workbench/api-helpers";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import {
  getActiveRender,
  subscribeRender,
} from "@/lib/workbench/render-service";
import type { RenderEvent } from "@/lib/workbench/types";

type RouteContext = {
  params:
    | Record<string, string | string[]>
    | Promise<Record<string, string | string[]>>;
};

/** SSE frame builder: `event: <name>\ndata: <json>\n\n`. */
function serialiseFrame(ev: RenderEvent): string {
  const name =
    ev.type === "stage"
      ? "stage"
      : ev.type === "line"
        ? "line"
        : ev.type === "heartbeat"
          ? "heartbeat"
          : "error";
  return `event: ${name}\ndata: ${JSON.stringify(ev)}\n\n`;
}

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);

    // Existence check up-front — subscribeRender itself would also throw
    // NO_RENDER, but handling it here lets us return the error as a
    // regular JSON envelope (respondError) rather than as an SSE frame
    // the browser would quietly swallow.
    const active = getActiveRender(projectId);
    if (!active) {
      throw new WorkbenchError(
        ErrorCode.NO_RENDER,
        "No active render for project",
        { projectId },
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const ev of subscribeRender(projectId)) {
            controller.enqueue(encoder.encode(serialiseFrame(ev)));
          }
          controller.close();
        } catch (err) {
          // Last-resort error frame so the client observes a clean
          // shutdown rather than a mid-stream drop.
          try {
            const errEvent: RenderEvent = {
              type: "error",
              code: ErrorCode.UNKNOWN,
              message: err instanceof Error ? err.message : String(err),
            };
            controller.enqueue(encoder.encode(serialiseFrame(errEvent)));
            controller.close();
          } catch {
            // controller already closed — nothing more to do.
          }
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    return respondError(e);
  }
}
