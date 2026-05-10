import { afterAll, afterEach, beforeAll } from "vitest";
import { setupServer } from "msw/node";

// Feature: video-creation-workbench
//
// MSW node server for integration tests that mock outbound HTTP (OpenAI
// LLM / TTS, Anthropic, etc.). The server starts with an *empty* handler
// set — each test file adds handlers via `server.use(...)`.
//
// See design.md §Integration Tests: "OpenAI LLM / TTS: mocked at the
// HTTP layer with MSW. No real API calls in CI."

export const server = setupServer();

/**
 * Wire the standard MSW lifecycle into a vitest test file.
 *
 * - beforeAll: start the interceptor, warn on any unhandled request.
 * - afterEach: reset per-test handlers so one test cannot leak into another.
 * - afterAll: tear the interceptor down.
 *
 * Usage:
 *   import { installMswLifecycle, server } from "@/test/fixtures/msw-server";
 *   installMswLifecycle();
 *   it("calls the API", () => {
 *     server.use(http.get(...));
 *     // ...
 *   });
 */
export function installMswLifecycle(): void {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "warn" });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });
}
