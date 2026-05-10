/**
 * Video Creation Workbench — unified error handling.
 *
 * Every non-2xx API response returns an `ErrorResponse` envelope. Route
 * handlers throw `WorkbenchError` (or let a `ZodError` / unknown error
 * propagate) and close with `return respondWithError(e)`.
 *
 * See design §Error Handling for the canonical ErrorCode list and the
 * error-to-HTTP-status matrix; this module is the single implementation
 * of both.
 */

import { LIMITS } from "./constants";
import type { ErrorResponse } from "./types";

// ---------------------------------------------------------------------------
// ErrorCode — stable identifiers, SCREAMING_SNAKE_CASE, ≤64 chars.
// ---------------------------------------------------------------------------

/**
 * Every stable error identifier the workbench surfaces through the API.
 *
 * _Requirements: 14.1, 14.7_
 */
export enum ErrorCode {
  // Validation / input (400)
  VALIDATION_FAILED = "VALIDATION_FAILED",
  INVALID_PROJECT_ID = "INVALID_PROJECT_ID",
  INVALID_SCENE_ID = "INVALID_SCENE_ID",
  INVALID_SCENE_INDEX = "INVALID_SCENE_INDEX",
  CONTROL_CHAR_REJECTED = "CONTROL_CHAR_REJECTED",
  PATH_TRAVERSAL_REJECTED = "PATH_TRAVERSAL_REJECTED",

  // Request-size / semantic input (413 / 422)
  PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE",
  TOPIC_INVALID = "TOPIC_INVALID",

  // Not found (404)
  PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND",
  SCENE_NOT_FOUND = "SCENE_NOT_FOUND",
  AUDIO_NOT_FOUND = "AUDIO_NOT_FOUND",
  COMPOSITION_NOT_FOUND = "COMPOSITION_NOT_FOUND",

  // Conflicts (409)
  INVALID_TRANSITION = "INVALID_TRANSITION",
  STAGE_ALREADY_DONE = "STAGE_ALREADY_DONE",
  INVALID_STAGE = "INVALID_STAGE",
  STORYBOARD_LIMIT = "STORYBOARD_LIMIT",
  CONCURRENT_TRANSITION = "CONCURRENT_TRANSITION",
  RENDER_IN_PROGRESS = "RENDER_IN_PROGRESS",
  TEMPLATE_CONFLICT = "TEMPLATE_CONFLICT",
  SCHEMA_VERSION_MISMATCH = "SCHEMA_VERSION_MISMATCH",
  CANNOT_PUBLISH = "CANNOT_PUBLISH",
  NO_RENDER = "NO_RENDER",
  LOCK_BUSY = "LOCK_BUSY",

  // External-service failures (502)
  LLM_OUTPUT_INVALID = "LLM_OUTPUT_INVALID",
  LINT_FAILED = "LINT_FAILED",
  VALIDATE_FAILED = "VALIDATE_FAILED",

  // Timeouts (504)
  LLM_TIMEOUT = "LLM_TIMEOUT",
  TTS_TIMEOUT = "TTS_TIMEOUT",
  RENDER_TIMEOUT = "RENDER_TIMEOUT",

  // Server / filesystem (500)
  TEMPLATE_NOT_FOUND = "TEMPLATE_NOT_FOUND",
  TEMPLATE_COPY_FAILED = "TEMPLATE_COPY_FAILED",
  TTS_PROVIDER_UNCONFIGURED = "TTS_PROVIDER_UNCONFIGURED",
  AUDIO_INJECT_ROLLBACK = "AUDIO_INJECT_ROLLBACK",
  PREV_RENAME_FAILED = "PREV_RENAME_FAILED",
  PARTIAL_DELETE = "PARTIAL_DELETE",
  WRITE_FAILED = "WRITE_FAILED",
  READ_FAILED = "READ_FAILED",
  UNKNOWN = "UNKNOWN",
}

// ---------------------------------------------------------------------------
// HTTP-status matrix — single source of truth for code → status.
// ---------------------------------------------------------------------------

/**
 * Maps each `ErrorCode` to its HTTP status per design §Error-to-HTTP-Status
 * Matrix. Keep this in lockstep with the matrix in the design doc.
 *
 * _Requirements: 14.1_
 */
export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  // 400
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.INVALID_PROJECT_ID]: 400,
  [ErrorCode.INVALID_SCENE_ID]: 400,
  [ErrorCode.INVALID_SCENE_INDEX]: 400,
  [ErrorCode.CONTROL_CHAR_REJECTED]: 400,
  [ErrorCode.PATH_TRAVERSAL_REJECTED]: 400,

  // 413 / 422
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.TOPIC_INVALID]: 422,

  // 404
  [ErrorCode.PROJECT_NOT_FOUND]: 404,
  [ErrorCode.SCENE_NOT_FOUND]: 404,
  [ErrorCode.AUDIO_NOT_FOUND]: 404,
  [ErrorCode.COMPOSITION_NOT_FOUND]: 404,

  // 409
  [ErrorCode.INVALID_TRANSITION]: 409,
  [ErrorCode.STAGE_ALREADY_DONE]: 409,
  [ErrorCode.INVALID_STAGE]: 409,
  [ErrorCode.STORYBOARD_LIMIT]: 409,
  [ErrorCode.CONCURRENT_TRANSITION]: 409,
  [ErrorCode.RENDER_IN_PROGRESS]: 409,
  [ErrorCode.TEMPLATE_CONFLICT]: 409,
  [ErrorCode.SCHEMA_VERSION_MISMATCH]: 409,
  [ErrorCode.CANNOT_PUBLISH]: 409,
  [ErrorCode.NO_RENDER]: 409,
  [ErrorCode.LOCK_BUSY]: 409,

  // 502
  [ErrorCode.LLM_OUTPUT_INVALID]: 502,
  [ErrorCode.LINT_FAILED]: 502,
  [ErrorCode.VALIDATE_FAILED]: 502,

  // 504
  [ErrorCode.LLM_TIMEOUT]: 504,
  [ErrorCode.TTS_TIMEOUT]: 504,
  [ErrorCode.RENDER_TIMEOUT]: 504,

  // 500
  [ErrorCode.TEMPLATE_NOT_FOUND]: 500,
  [ErrorCode.TEMPLATE_COPY_FAILED]: 500,
  [ErrorCode.TTS_PROVIDER_UNCONFIGURED]: 500,
  [ErrorCode.AUDIO_INJECT_ROLLBACK]: 500,
  [ErrorCode.PREV_RENAME_FAILED]: 500,
  [ErrorCode.PARTIAL_DELETE]: 500,
  [ErrorCode.WRITE_FAILED]: 500,
  [ErrorCode.READ_FAILED]: 500,
  [ErrorCode.UNKNOWN]: 500,
};

// ---------------------------------------------------------------------------
// WorkbenchError
// ---------------------------------------------------------------------------

/**
 * Truncate an arbitrary message to `LIMITS.ERROR_MESSAGE_MAX`. When the
 * input exceeds the limit, the first `MAX - 1` chars are kept and a `…`
 * suffix is appended so the result is exactly `MAX` chars long.
 *
 * _Requirements: 14.1, 14.7_
 */
function truncateMessage(message: string): string {
  const max = LIMITS.ERROR_MESSAGE_MAX;
  if (message.length <= max) return message;
  return message.slice(0, max - 1) + "…";
}

/**
 * Canonical error type thrown by workbench code paths. Route handlers
 * catch it and serialise via `toResponse()` / `respondWithError()`.
 *
 * Invariants:
 *   - `code` is an `ErrorCode` (≤64 chars by construction).
 *   - `message` is truncated to `LIMITS.ERROR_MESSAGE_MAX` chars.
 *   - `details` is an optional structured context payload.
 *
 * _Requirements: 14.1, 14.7_
 */
export class WorkbenchError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(truncateMessage(message));
    this.name = "WorkbenchError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
    // Restore prototype chain across down-leveled ES targets.
    Object.setPrototypeOf(this, WorkbenchError.prototype);
  }

  /** HTTP status derived from `code` via `HTTP_STATUS_BY_CODE`. */
  get httpStatus(): number {
    return HTTP_STATUS_BY_CODE[this.code];
  }

  /**
   * Serialise to the unified error envelope. Omits the `details` key
   * entirely when no details were supplied (never emits `details: undefined`).
   */
  toResponse(): ErrorResponse {
    const body: ErrorResponse["error"] = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) {
      body.details = this.details;
    }
    return { error: body };
  }
}

/** Type guard for `WorkbenchError`. */
export function isWorkbenchError(e: unknown): e is WorkbenchError {
  return e instanceof WorkbenchError;
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

/**
 * Convenience helper for route handlers: throws `WorkbenchError(code,
 * message, details)` when `condition` is falsy. Uses TypeScript's
 * `asserts` syntax so the compiler narrows the variable after the call.
 */
export function assertOrThrow(
  condition: unknown,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) {
    throw new WorkbenchError(code, message, details);
  }
}

// ---------------------------------------------------------------------------
// respondWithError — the single error-to-Response mapper.
// ---------------------------------------------------------------------------

/**
 * Minimal structural check for a zod `ZodError` without importing zod from
 * this module. zod's errors have `name === "ZodError"` and carry an
 * `issues: ZodIssue[]` array. This lets `errors.ts` stay a leaf module.
 */
function looksLikeZodError(
  e: unknown,
): e is { name: string; issues: unknown[]; message?: string } {
  if (!e || typeof e !== "object") return false;
  const maybe = e as { name?: unknown; issues?: unknown };
  return (
    maybe.name === "ZodError" &&
    Array.isArray(maybe.issues)
  );
}

/**
 * Map any caught value to a `Response`.
 *
 * - `WorkbenchError` → `e.httpStatus` + `e.toResponse()`
 * - `ZodError`-shaped → `400 VALIDATION_FAILED` with `issues` as details
 * - Anything else → `500 UNKNOWN` with a generic message; full error is
 *   logged via `console.error` and never surfaced to the client (no stack
 *   leak, no raw message passthrough).
 *
 * _Requirements: 14.1, 14.7_
 */
export function respondWithError(e: unknown): Response {
  if (isWorkbenchError(e)) {
    return Response.json(e.toResponse(), { status: e.httpStatus });
  }

  if (looksLikeZodError(e)) {
    const wrapped = new WorkbenchError(
      ErrorCode.VALIDATION_FAILED,
      "Request validation failed",
      { issues: e.issues },
    );
    return Response.json(wrapped.toResponse(), { status: wrapped.httpStatus });
  }

  // Unknown — log full context server-side, return a sanitised envelope.
  // (Stage workflows use a structured logger; this console.error is the
  // last-resort catch-all for Route Handlers.)
  console.error("[workbench] unhandled error:", e);
  const unknownErr = new WorkbenchError(ErrorCode.UNKNOWN, "Internal error");
  return Response.json(unknownErr.toResponse(), {
    status: unknownErr.httpStatus,
  });
}
