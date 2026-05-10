/**
 * Route tests for `GET /api/projects/{id}/audio/scenes/{index}`.
 *
 * Feature: video-creation-workbench — T54
 *
 * Each test seeds a fresh tmp-dir sandbox and points the route handler's
 * filesystem access at it via `WORKBENCH_DATA_DIR` (the override the
 * `path-safety` helpers already honour). The Project JSON itself is not
 * created — this endpoint only checks the mp3 file on disk, not the
 * project record, so only the `composition/assets/scene-{n}.mp3` path
 * needs to exist.
 *
 * Covers:
 *   - No-Range → 200 full body
 *   - Prefix range (0-499) → 206 with the correct slice
 *   - Open-ended range (500-) → 206 through end of file
 *   - Invalid range syntax → 416 (we return 416, not 400, per RFC 7233 §4.4)
 *   - Out-of-bounds range → 416 with `Content-Range: bytes *\/{size}`
 *   - Index validation: `0`, `21`, `abc` → 400
 *   - Missing file → 404 `AUDIO_NOT_FOUND`
 *
 * _Requirements: 9.10, 12.6, 12.11, 16.4, 16.6_
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";

import { GET } from "./route";
import { createTmpDir, type TmpDir } from "@/test/fixtures/tmp-dir";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const PROJECT_ID = "proj_1700000000000_abc123";

function makeRequest(
  projectId: string,
  index: string,
  headers?: Record<string, string>,
): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/projects/${projectId}/audio/scenes/${index}`,
    { method: "GET", headers },
  );
}

function makeCtx(projectId: string, index: string) {
  return { params: Promise.resolve({ id: projectId, index }) };
}

async function seedSceneFile(
  dataDir: string,
  projectId: string,
  sceneIndex: number,
  bytes: Buffer,
): Promise<string> {
  const assetsDir = path.join(
    dataDir,
    projectId,
    "composition",
    "assets",
  );
  await mkdir(assetsDir, { recursive: true });
  const filePath = path.join(assetsDir, `scene-${sceneIndex}.mp3`);
  await writeFile(filePath, bytes);
  return filePath;
}

// ---------------------------------------------------------------------------
// Per-test tmp-dir + WORKBENCH_DATA_DIR override
// ---------------------------------------------------------------------------

describe("GET /api/projects/[id]/audio/scenes/[index]", () => {
  let tmp: TmpDir;
  let prevOverride: string | undefined;

  beforeEach(async () => {
    tmp = await createTmpDir("workbench-audio-scenes-route-");
    prevOverride = process.env.WORKBENCH_DATA_DIR;
    // `getDataDirAbs()` reads this on each call, so assigning it here is
    // enough — no process.chdir needed.
    process.env.WORKBENCH_DATA_DIR = tmp.path;
  });

  afterEach(async () => {
    if (prevOverride === undefined) {
      delete process.env.WORKBENCH_DATA_DIR;
    } else {
      process.env.WORKBENCH_DATA_DIR = prevOverride;
    }
    await tmp.cleanup();
  });

  // -------------------------------------------------------------------------
  // 1. No-Range GET — full 1000-byte buffer
  // -------------------------------------------------------------------------
  it("returns 200 with the full buffer when no Range header is present", async () => {
    const bytes = Buffer.alloc(1000, 0xab);
    await seedSceneFile(tmp.path, PROJECT_ID, 2, bytes);

    const res = await GET(
      makeRequest(PROJECT_ID, "2"),
      makeCtx(PROJECT_ID, "2"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("content-length")).toBe("1000");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(1000);
    expect(body.equals(bytes)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Prefix range — bytes=0-499
  // -------------------------------------------------------------------------
  it("returns 206 with the first 500 bytes for Range: bytes=0-499", async () => {
    const bytes = Buffer.alloc(1000, 0xab);
    await seedSceneFile(tmp.path, PROJECT_ID, 2, bytes);

    const res = await GET(
      makeRequest(PROJECT_ID, "2", { Range: "bytes=0-499" }),
      makeCtx(PROJECT_ID, "2"),
    );

    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("content-range")).toBe("bytes 0-499/1000");
    expect(res.headers.get("content-length")).toBe("500");
    expect(res.headers.get("accept-ranges")).toBe("bytes");

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(500);
    expect(body.equals(bytes.subarray(0, 500))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Open-ended range — bytes=500-
  // -------------------------------------------------------------------------
  it("returns 206 through end of file for Range: bytes=500-", async () => {
    const bytes = Buffer.alloc(1000, 0xab);
    await seedSceneFile(tmp.path, PROJECT_ID, 2, bytes);

    const res = await GET(
      makeRequest(PROJECT_ID, "2", { Range: "bytes=500-" }),
      makeCtx(PROJECT_ID, "2"),
    );

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 500-999/1000");
    expect(res.headers.get("content-length")).toBe("500");

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(500);
    expect(body.equals(bytes.subarray(500, 1000))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Invalid range syntax — we chose 416 per RFC 7233 §4.4
  // -------------------------------------------------------------------------
  it("returns 416 for an unparseable Range value (`bytes=abc`)", async () => {
    const bytes = Buffer.alloc(1000, 0xab);
    await seedSceneFile(tmp.path, PROJECT_ID, 2, bytes);

    const res = await GET(
      makeRequest(PROJECT_ID, "2", { Range: "bytes=abc" }),
      makeCtx(PROJECT_ID, "2"),
    );

    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. Out-of-bounds range — bytes=2000-3000
  // -------------------------------------------------------------------------
  it("returns 416 with the correct Content-Range for an out-of-bounds range", async () => {
    const bytes = Buffer.alloc(1000, 0xab);
    await seedSceneFile(tmp.path, PROJECT_ID, 2, bytes);

    const res = await GET(
      makeRequest(PROJECT_ID, "2", { Range: "bytes=2000-3000" }),
      makeCtx(PROJECT_ID, "2"),
    );

    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
  });

  // -------------------------------------------------------------------------
  // 6. Index validation — `0`, `21`, `abc` all → 400 INVALID_SCENE_INDEX
  // -------------------------------------------------------------------------
  it("rejects index `0` with 400 INVALID_SCENE_INDEX", async () => {
    const res = await GET(
      makeRequest(PROJECT_ID, "0"),
      makeCtx(PROJECT_ID, "0"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_SCENE_INDEX");
  });

  it("rejects index `21` (above MAX_SCENES=20) with 400 INVALID_SCENE_INDEX", async () => {
    const res = await GET(
      makeRequest(PROJECT_ID, "21"),
      makeCtx(PROJECT_ID, "21"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_SCENE_INDEX");
  });

  it("rejects non-digit index `abc` with 400 INVALID_SCENE_INDEX", async () => {
    const res = await GET(
      makeRequest(PROJECT_ID, "abc"),
      makeCtx(PROJECT_ID, "abc"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_SCENE_INDEX");
  });

  // -------------------------------------------------------------------------
  // 7. Missing file — index `3` has no mp3 on disk
  // -------------------------------------------------------------------------
  it("returns 404 AUDIO_NOT_FOUND when the scene mp3 does not exist", async () => {
    // Seed scene 2 so the project dir exists; scene 3 is absent.
    await seedSceneFile(tmp.path, PROJECT_ID, 2, Buffer.alloc(1000, 0xab));

    const res = await GET(
      makeRequest(PROJECT_ID, "3"),
      makeCtx(PROJECT_ID, "3"),
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("AUDIO_NOT_FOUND");
  });
});
