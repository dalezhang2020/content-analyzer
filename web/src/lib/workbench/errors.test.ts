/**
 * Property + spot tests for `errors.ts`.
 *
 * Feature: video-creation-workbench — T06.2
 *
 * Property 24: Every WorkbenchError serialises to the unified error schema.
 *
 * Validates: Requirements 14.1, 14.7
 *
 * Notes
 * - Property uses arbitrary `ErrorCode` + arbitrary message (covering both
 *   short strings and long strings ≥ 500 chars so the truncation branch is
 *   exercised) + arbitrary optional `details` object.
 * - Spot tests cover `respondWithError` against `WorkbenchError`, a
 *   `ZodError` produced by a minimal schema failure, and a plain unknown
 *   `Error` (must map to 500 `UNKNOWN` with message `"Internal error"`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { z } from "zod";

import {
  ErrorCode,
  HTTP_STATUS_BY_CODE,
  WorkbenchError,
  respondWithError,
} from "@/lib/workbench/errors";
import { ErrorResponseSchema } from "@/lib/workbench/schemas";
import { LIMITS } from "@/lib/workbench/constants";

describe("errors — Property 24: serialisation + respondWithError mapping", () => {
  // Suppress the `console.error` noise from the unknown-error branch of
  // `respondWithError`; we assert on status + body, not on the log line.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Arbitraries
  // -------------------------------------------------------------------------

  const ERROR_CODES = Object.values(ErrorCode) as ErrorCode[];
  const codeArb = fc.constantFrom<ErrorCode>(...ERROR_CODES);

  // Oneof short + long messages so shrinking can land in either branch of
  // the truncation logic. The long generator is seeded above 500 chars.
  const messageArb = fc.oneof(
    { arbitrary: fc.string({ maxLength: 499 }), weight: 2 },
    {
      arbitrary: fc.string({ minLength: 500, maxLength: 1500 }),
      weight: 1,
    },
  );

  // Keep details as a plain JSON-ish record. `ErrorResponseSchema` uses
  // `z.record(z.string(), z.unknown())` so any object with string keys is
  // valid; we restrict values to primitives/arrays to avoid pulling in
  // exotic shapes (Sets, Maps, etc.) that would add noise without improving
  // coverage of the serialisation contract.
  const detailsValueArb = fc.oneof(
    fc.string({ maxLength: 40 }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
  );
  const detailsArb = fc.option(
    fc.dictionary(fc.string({ maxLength: 20 }), detailsValueArb, {
      maxKeys: 5,
    }),
    { nil: undefined },
  );

  // -------------------------------------------------------------------------
  // Property 24
  // -------------------------------------------------------------------------

  it("every WorkbenchError serialises to ErrorResponseSchema with truncated message and enum code", () => {
    fc.assert(
      fc.property(codeArb, messageArb, detailsArb, (code, message, details) => {
        const err = new WorkbenchError(code, message, details);
        const resp = err.toResponse();

        // 1. Conforms to the unified error envelope.
        const parsed = ErrorResponseSchema.parse(resp);
        expect(parsed).toEqual(resp);

        // 2. Code is always a value from the ErrorCode enum.
        expect(ERROR_CODES).toContain(resp.error.code as ErrorCode);

        // 3. Code is ≤ ERROR_CODE_MAX (guaranteed by enum, double-check).
        expect(resp.error.code.length).toBeLessThanOrEqual(
          LIMITS.ERROR_CODE_MAX,
        );

        // 4. Message ≤ 500 chars and truncated with `…` suffix iff needed.
        const max = LIMITS.ERROR_MESSAGE_MAX;
        expect(resp.error.message.length).toBeLessThanOrEqual(max);
        if (message.length <= max) {
          expect(resp.error.message).toBe(message);
        } else {
          expect(resp.error.message.length).toBe(max);
          expect(resp.error.message.endsWith("…")).toBe(true);
          // Preserves the first (max - 1) chars verbatim.
          expect(resp.error.message.slice(0, max - 1)).toBe(
            message.slice(0, max - 1),
          );
        }

        // 5. Details key is present iff the caller supplied one.
        if (details === undefined) {
          expect("details" in resp.error).toBe(false);
        } else {
          expect(resp.error.details).toEqual(details);
        }
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Spot tests — respondWithError mapping
  // -------------------------------------------------------------------------

  it("respondWithError maps a WorkbenchError to its HTTP status + envelope", async () => {
    const err = new WorkbenchError(
      ErrorCode.INVALID_TRANSITION,
      "cannot jump from topic to render",
      { currentStage: "topic", requestedStage: "render" },
    );
    const res = respondWithError(err);

    expect(res.status).toBe(HTTP_STATUS_BY_CODE[ErrorCode.INVALID_TRANSITION]);
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
    expect(body.error.code).toBe(ErrorCode.INVALID_TRANSITION);
    expect(body.error.message).toBe("cannot jump from topic to render");
    expect(body.error.details).toEqual({
      currentStage: "topic",
      requestedStage: "render",
    });
  });

  it("respondWithError maps a ZodError to 400 VALIDATION_FAILED with issues in details", async () => {
    const minimalSchema = z.object({ x: z.string() });
    const parsed = minimalSchema.safeParse({ x: 42 });
    // Sanity: we're feeding an actual ZodError to the mapper.
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("unreachable");
    const zodError = parsed.error;

    const res = respondWithError(zodError);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
    expect(body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(body.error.message).toBe("Request validation failed");
    expect(body.error.details).toBeDefined();
    expect(Array.isArray(body.error.details.issues)).toBe(true);
    expect(body.error.details.issues.length).toBe(zodError.issues.length);
  });

  it("respondWithError maps an unknown Error to 500 UNKNOWN with a sanitised message", async () => {
    const res = respondWithError(new Error("boom: stack trace should not leak"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
    expect(body.error.code).toBe(ErrorCode.UNKNOWN);
    expect(body.error.message).toBe("Internal error");
    // No details leaked to the client on the unknown branch.
    expect("details" in body.error).toBe(false);
    // The raw error is still logged server-side.
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
