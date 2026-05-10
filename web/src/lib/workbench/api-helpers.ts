/**
 * Video Creation Workbench — Route Handler request-pipeline helpers.
 *
 * Every Route Handler under `src/app/api/**` funnels its pre-checks
 * through this module:
 *   - `parseJsonBody()` reads the request body with a size ceiling
 *     (`PAYLOAD_TOO_LARGE` on overflow) and runs it through a zod schema.
 *   - `parseWithSchema()` is the zero-I/O variant for already-deserialised
 *     data (e.g. query params).
 *   - `requireProjectIdFromParams()` / `requireSceneIdFromParams()` accept
 *     Next.js 16's Promise-wrapped params (dynamic APIs) and hand back a
 *     regex-validated identifier.
 *   - `respondJson()` / `respondError()` are the canonical success /
 *     failure serialisers — `respondError` is just a re-export of
 *     `respondWithError` from `./errors` for call-site symmetry.
 *   - `readForceFlag()` reads the optional `{ force?: boolean }` flag
 *     destructively-delete routes accept.
 *   - `awaitParams()` normalises the `ctx.params` shape so callers can
 *     uniformly `await` it without branching on promise-vs-plain.
 *
 * zod validation errors are NOT caught here — they bubble up and are
 * mapped to `VALIDATION_FAILED` 400 by `respondWithError` via its
 * structural `ZodError` check. This keeps the helpers tiny and the error
 * mapping centralised.
 */

import type { NextRequest } from "next/server";
import type { z } from "zod";

import { LIMITS } from "./constants";
import { ErrorCode, WorkbenchError, respondWithError } from "./errors";
import { assertValidProjectId, assertValidSceneId } from "./path-safety";

// ---------------------------------------------------------------------------
// Params normalisation
// ---------------------------------------------------------------------------

/**
 * Next.js 16 exposes `ctx.params` as a Promise in dynamic Route Handlers
 * (the "dynamic APIs" change). This tiny helper accepts either a Promise
 * or a plain object so call sites can write:
 *
 * ```ts
 * const { id } = await awaitParams(ctx.params);
 * ```
 *
 * without branching on the runtime shape.
 */
export function awaitParams<T>(p: T | Promise<T>): Promise<T> {
  return Promise.resolve(p);
}

/**
 * Extracts a single string value from a params record, rejecting the
 * `string[]` catch-all shape Next.js uses for optional-catch-all routes.
 * Returns `null` when the key is missing or not a string.
 */
function readParamString(
  params: Record<string, string | string[]>,
  key: string,
): string | null {
  const value = params[key];
  return typeof value === "string" ? value : null;
}

/**
 * Await (if needed) a params record, extract `id`, validate it against
 * `REGEX.PROJECT_ID`, and return it. Throws
 * `WorkbenchError(INVALID_PROJECT_ID)` for any miss (wrong type, missing
 * key, or regex mismatch).
 */
export async function requireProjectIdFromParams(
  params:
    | Record<string, string | string[]>
    | Promise<Record<string, string | string[]>>,
): Promise<string> {
  const resolved = await awaitParams(params);
  const id = readParamString(resolved, "id");
  if (id === null) {
    throw new WorkbenchError(
      ErrorCode.INVALID_PROJECT_ID,
      "Missing project id in route params",
      { key: "id" },
    );
  }
  assertValidProjectId(id);
  return id;
}

/**
 * Await (if needed) a params record, extract `sceneId`, validate it
 * against `REGEX.SCENE_ID`, and return it. Throws
 * `WorkbenchError(INVALID_SCENE_ID)` for any miss.
 */
export async function requireSceneIdFromParams(
  params:
    | Record<string, string | string[]>
    | Promise<Record<string, string | string[]>>,
): Promise<string> {
  const resolved = await awaitParams(params);
  const sceneId = readParamString(resolved, "sceneId");
  if (sceneId === null) {
    throw new WorkbenchError(
      ErrorCode.INVALID_SCENE_ID,
      "Missing scene id in route params",
      { key: "sceneId" },
    );
  }
  assertValidSceneId(sceneId);
  return sceneId;
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

/**
 * Options for `parseJsonBody`.
 */
export interface ParseJsonBodyOptions {
  /**
   * Upper bound on the raw request body size in bytes. Defaults to
   * `LIMITS.REQUEST_BODY_MAX_BYTES` (1 MB). Generation endpoints that
   * accept larger HTML payloads pass `LIMITS.REQUEST_BODY_MAX_BYTES_GEN`
   * (4 MB) per Req 16.5.
   */
  maxBytes?: number;
}

/**
 * Read a JSON body from a Request / NextRequest with enforced size
 * ceiling and zod validation.
 *
 * Pipeline:
 *   1. Buffer the body via `req.arrayBuffer()` so we can measure size
 *      before spending CPU on decode/parse.
 *   2. If `byteLength > maxBytes` → throw `PAYLOAD_TOO_LARGE` with the
 *      limit and the observed size in `details`.
 *   3. Empty body → try `schema.parse({})` first (most body schemas are
 *      objects with all-optional fields and default to `{}`). On failure,
 *      fall through to `schema.parse(undefined)` so schemas declared as
 *      `.optional()` still pass. zod errors bubble up either way.
 *   4. Otherwise: UTF-8 decode → `JSON.parse` (wrap syntax errors as
 *      `VALIDATION_FAILED` with the parser reason) → `schema.parse`.
 *
 * zod errors are intentionally NOT caught here — `respondWithError`
 * structurally detects `ZodError` and maps it to 400 `VALIDATION_FAILED`
 * with the full issue list in `details`.
 */
export async function parseJsonBody<T>(
  req: Request | NextRequest,
  schema: z.ZodSchema<T>,
  opts?: ParseJsonBodyOptions,
): Promise<T> {
  const maxBytes = opts?.maxBytes ?? LIMITS.REQUEST_BODY_MAX_BYTES;

  const buffer = await req.arrayBuffer();
  const actualBytes = buffer.byteLength;

  if (actualBytes > maxBytes) {
    throw new WorkbenchError(
      ErrorCode.PAYLOAD_TOO_LARGE,
      "Request body exceeds maximum size",
      { maxBytes, actualBytes },
    );
  }

  if (actualBytes === 0) {
    // Most body schemas are objects with fully-optional fields and
    // `{}` passes cleanly. Fall back to `undefined` for `.optional()`
    // top-level schemas. Either attempt's zod error bubbles up.
    try {
      return schema.parse({});
    } catch {
      return schema.parse(undefined);
    }
  }

  const text = new TextDecoder("utf-8").decode(buffer);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new WorkbenchError(
      ErrorCode.VALIDATION_FAILED,
      "Invalid JSON body",
      { reason: e instanceof Error ? e.message : String(e) },
    );
  }

  return schema.parse(json);
}

/**
 * Zero-I/O variant of `parseJsonBody` for values that are already
 * deserialised (e.g. query parameters, already-parsed form fields).
 * Delegates straight to `schema.parse` so zod errors flow through
 * `respondWithError` unchanged.
 */
export function parseWithSchema<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
): T {
  return schema.parse(data);
}

// ---------------------------------------------------------------------------
// Response serialisers
// ---------------------------------------------------------------------------

/**
 * Canonical success-path serialiser. Delegates to `Response.json` so
 * Next.js picks up the correct `Content-Type: application/json`.
 */
export function respondJson<T>(body: T, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Canonical failure-path serialiser. Re-exports `respondWithError` from
 * `./errors` under a route-local name so helpers and error mapping sit
 * behind a single import at call sites.
 *
 * Maps:
 *   - `WorkbenchError` → `e.httpStatus`
 *   - `ZodError`-shaped → 400 `VALIDATION_FAILED` with `issues`
 *   - anything else → 500 `UNKNOWN` (no stack leak)
 */
export function respondError(e: unknown): Response {
  return respondWithError(e);
}

// ---------------------------------------------------------------------------
// Misc body flags
// ---------------------------------------------------------------------------

/**
 * Read the optional `force` flag used by destructive routes (project
 * delete, template reset). Returns `true` only when the body is a plain
 * object with `force === true`; all other shapes default to `false`.
 */
export function readForceFlag(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  return (body as { force?: unknown }).force === true;
}
