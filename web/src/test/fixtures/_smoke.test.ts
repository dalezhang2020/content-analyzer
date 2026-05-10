import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createTmpDir } from "./tmp-dir";
import { projectArb, sceneArb, stageStatusMapArb } from "./project-builder";
import { server } from "./msw-server";
import { stat } from "node:fs/promises";

// Feature: video-creation-workbench
// T03 smoke test — verifies global fast-check config + fixtures load and
// the tmp-dir helper actually creates + cleans up a directory. Not a
// property assertion; just a setup integrity check.

describe("test fixtures smoke", () => {
  it("fast-check global config applies (seed pinned)", () => {
    const g = fc.readConfigureGlobal();
    expect(g.seed).toBe(0xbeef);
    expect(g.numRuns).toBe(100);
  });

  it("no-op fc.assert runs without throwing", () => {
    fc.assert(
      fc.property(projectArb, sceneArb, stageStatusMapArb, () => true),
    );
  });

  it("createTmpDir creates a unique dir and cleanup removes it", async () => {
    const tmp = await createTmpDir("workbench-smoke-");
    const s = await stat(tmp.path);
    expect(s.isDirectory()).toBe(true);

    await tmp.cleanup();
    await expect(stat(tmp.path)).rejects.toMatchObject({ code: "ENOENT" });

    // Idempotent
    await tmp.cleanup();
  });

  it("msw server is a constructed setupServer instance", () => {
    expect(server).toBeDefined();
    expect(typeof server.listen).toBe("function");
    expect(typeof server.close).toBe("function");
    expect(typeof server.resetHandlers).toBe("function");
  });
});
