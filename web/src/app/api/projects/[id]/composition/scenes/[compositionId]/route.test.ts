/**
 * Route test for
 * `GET /api/projects/{id}/composition/scenes/{compositionId}`.
 *
 * Verifies:
 *   - 200 response wraps the sub-composition bytes in a host HTML doc
 *     with `text/html` content-type and the GSAP cdn + `window.__timelines`
 *     wiring the iframe needs to actually play the animation.
 *   - Invalid compositionId → 400 VALIDATION_FAILED.
 *   - Missing sub-composition file → 404 COMPOSITION_NOT_FOUND.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";

import { GET } from "./route";
import { createTmpDir, type TmpDir } from "@/test/fixtures/tmp-dir";

const PROJECT_ID = "proj_1778375317741_abcdef";
const COMPOSITION_ID = "scene-03-abc123";
const SUB_COMPOSITION_HTML =
  `<template id="${COMPOSITION_ID}-template"><div id="${COMPOSITION_ID}">hello</div></template>`;

let tmp: TmpDir;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await createTmpDir("workbench-scene-route-");
  originalEnv = process.env.WORKBENCH_DATA_DIR;
  // Point the workbench data dir at our sandbox. `getDataDirAbs()` reads
  // this env at call time, so we can avoid `process.chdir`.
  process.env.WORKBENCH_DATA_DIR = tmp.path;

  // Seed the sub-composition file:
  //   {tmp}/{projectId}/composition/compositions/{compositionId}.html
  const dir = path.join(tmp.path, PROJECT_ID, "composition", "compositions");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, COMPOSITION_ID + ".html"),
    SUB_COMPOSITION_HTML,
    "utf-8",
  );
});

afterEach(async () => {
  if (originalEnv === undefined) {
    delete process.env.WORKBENCH_DATA_DIR;
  } else {
    process.env.WORKBENCH_DATA_DIR = originalEnv;
  }
  await tmp.cleanup();
});

describe("GET /api/projects/[id]/composition/scenes/[compositionId]", () => {
  it("returns 200 with text/html host doc wrapping the sub-composition", async () => {
    const res = await GET(new NextRequest("http://localhost/"), {
      params: Promise.resolve({
        id: PROJECT_ID,
        compositionId: COMPOSITION_ID,
      }),
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("Content-Type") ?? "";
    expect(contentType.startsWith("text/html")).toBe(true);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.text();

    // Host doc wiring — the bits an iframe actually needs.
    expect(body).toContain("gsap@3.12.5");
    expect(body).toContain("window.__timelines");
    // Template lookup id is suffixed with `-template`; the plain
    // compositionId is used for timeline lookup.
    expect(body).toContain(`"${COMPOSITION_ID}-template"`);
    expect(body).toContain(`"${COMPOSITION_ID}"`);

    // Original sub-composition bytes flow through verbatim.
    expect(body).toContain(SUB_COMPOSITION_HTML);
  });

  it("returns 400 VALIDATION_FAILED for a malformed compositionId", async () => {
    const res = await GET(new NextRequest("http://localhost/"), {
      params: Promise.resolve({
        id: PROJECT_ID,
        compositionId: "bogus-id",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 404 COMPOSITION_NOT_FOUND when the sub-composition file is missing", async () => {
    const res = await GET(new NextRequest("http://localhost/"), {
      params: Promise.resolve({
        id: PROJECT_ID,
        compositionId: "scene-99-ffffff",
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("COMPOSITION_NOT_FOUND");
  });
});
