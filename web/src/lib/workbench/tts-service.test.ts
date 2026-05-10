/**
 * Integration tests for `tts-service.ts` with MSW mocking the Azure
 * Cognitive Services Speech REST API.
 *
 * Scope: verifies the public surface of `synthesizeAll` / `synthesizeOne`
 * against a mocked Azure endpoint. Covers happy paths, retry-on-5xx,
 * skip-existing, partial failures, unknown scene IDs, and env-var
 * short-circuit.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { http, HttpResponse } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createTmpDir, type TmpDir } from "@/test/fixtures/tmp-dir";
import { server } from "@/test/fixtures/msw-server";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import type {
  Project,
  Scene,
  StageStatusMap,
  Stage,
} from "@/lib/workbench/types";
import { synthesizeAll, synthesizeOne } from "@/lib/workbench/tts-service";

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const TEST_ENDPOINT = "https://test.example.com";
const TEST_KEY = "test-key-12345678";
const TTS_URL = `${TEST_ENDPOINT}/cognitiveservices/v1`;

// Small fake mp3 bytes — just a valid-ish MPEG frame header. We only
// verify these bytes round-trip to disk.
const FAKE_MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00]);

// ---------------------------------------------------------------------------
// MSW lifecycle (inlined so we can also install the shared-server resets)
// ---------------------------------------------------------------------------

beforeAll(() => {
  server.listen({ onUnhandledRequest: "warn" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// Per-test tmp dir + cwd + env setup
// ---------------------------------------------------------------------------

let tmp: TmpDir;
let originalCwd: string;
let setTimeoutSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(async () => {
  tmp = await createTmpDir("tts-service-");
  originalCwd = process.cwd();
  process.chdir(tmp.path);

  process.env.AZURE_SPEECH_ENDPOINT = TEST_ENDPOINT;
  process.env.AZURE_SPEECH_KEY = TEST_KEY;

  // Speed up TTS_BACKOFF_MS delays (1s / 3s) while leaving the 60s abort
  // timer alone — we still want real AbortController semantics if a test
  // ever deliberately stalls.
  const realSetTimeout = globalThis.setTimeout;
  setTimeoutSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(
      ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        const effective =
          typeof delay === "number" && delay > 0 && delay < 10_000 ? 0 : delay;
        return realSetTimeout(fn, effective, ...args);
      }) as unknown as typeof globalThis.setTimeout,
    );
});

afterEach(async () => {
  setTimeoutSpy?.mockRestore();
  setTimeoutSpy = null;
  process.chdir(originalCwd);
  await tmp.cleanup();
  delete process.env.AZURE_SPEECH_ENDPOINT;
  delete process.env.AZURE_SPEECH_KEY;
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ALL_STAGES: readonly Stage[] = [
  "topic",
  "brief",
  "storyboard",
  "composition",
  "audio",
  "render",
  "qa",
  "published",
];

function pendingStageMap(): StageStatusMap {
  const m = {} as StageStatusMap;
  for (const s of ALL_STAGES) m[s] = { status: "pending" };
  return m;
}

function makeScene(overrides: Partial<Scene> & { index: number }): Scene {
  const pad = String(overrides.index).padStart(2, "0");
  return {
    sceneId: `sc_abcd00${pad}`,
    index: overrides.index,
    title: overrides.title ?? `Scene ${overrides.index}`,
    narration: overrides.narration ?? `narration for scene ${overrides.index}`,
    durationSec: overrides.durationSec ?? 5,
    voice: overrides.voice ?? "zh-CN-XiaoxiaoNeural",
    audioPath: overrides.audioPath ?? null,
    qaNote: overrides.qaNote ?? "",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function createTestProject(projectId: string, scenes: Scene[]): Project {
  return {
    schemaVersion: 1,
    projectId,
    title: "Test Project",
    topic: "a topic",
    locale: "zh-CN",
    stage: "composition",
    stageStatus: pendingStageMap(),
    stageHistory: [],
    brief: null,
    storyboard: { scenes },
    artifacts: {
      briefPath: null,
      storyboardPath: null,
      compositionDir: "composition",
      indexHtmlPath: "composition/index.html",
      hyperframesJsonPath: null,
      audioPaths: [],
      videoPath: null,
    },
    qaNotes: [],
    templateSource: {
      name: "linear-launch",
      version: "1.0.0",
      sourcePath: "/tmp/templates/linear-launch",
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

/** Absolute path under the tmp cwd where scene-N.mp3 should land. */
function sceneMp3Abs(projectId: string, index: number): string {
  return path.resolve(
    tmp.path,
    "data/projects",
    projectId,
    "composition/assets",
    `scene-${index}.mp3`,
  );
}

const PROJECT_ID = "proj_1700000000000_abc123";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("synthesizeAll", () => {
  it("writes mp3 for every scene on the happy path", async () => {
    const calls: string[] = [];
    server.use(
      http.post(TTS_URL, async ({ request }) => {
        calls.push(await request.text());
        return new HttpResponse(FAKE_MP3, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      }),
    );

    const project = createTestProject(PROJECT_ID, [
      makeScene({ index: 1 }),
      makeScene({ index: 2 }),
      makeScene({ index: 3 }),
    ]);

    const result = await synthesizeAll(project);

    expect(result.failures).toEqual([]);
    expect(result.scenes.map((s) => s.audioPath)).toEqual([
      "assets/scene-1.mp3",
      "assets/scene-2.mp3",
      "assets/scene-3.mp3",
    ]);
    expect(calls).toHaveLength(3);
    // Verify bytes reached disk.
    const written = await readFile(sceneMp3Abs(PROJECT_ID, 1));
    expect(Buffer.compare(written, FAKE_MP3)).toBe(0);
  });

  it("skips scenes whose mp3 already exists (force=false)", async () => {
    let callCount = 0;
    server.use(
      http.post(TTS_URL, () => {
        callCount++;
        return new HttpResponse(FAKE_MP3, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      }),
    );

    // Pre-seed scene-1.mp3 on disk.
    const existing = sceneMp3Abs(PROJECT_ID, 1);
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, Buffer.from("pre-existing-bytes"));

    const project = createTestProject(PROJECT_ID, [
      makeScene({ index: 1, audioPath: "assets/scene-1.mp3" }),
      makeScene({ index: 2 }),
    ]);

    const result = await synthesizeAll(project);

    expect(callCount).toBe(1); // Only scene 2 hit Azure.
    expect(result.failures).toEqual([]);
    expect(result.scenes[0].audioPath).toBe("assets/scene-1.mp3");
    expect(result.scenes[1].audioPath).toBe("assets/scene-2.mp3");
    // Pre-existing bytes untouched.
    const kept = await readFile(existing);
    expect(kept.toString()).toBe("pre-existing-bytes");
  });

  it("retries on a 5xx response and succeeds on the second attempt", async () => {
    let callCount = 0;
    server.use(
      http.post(TTS_URL, () => {
        callCount++;
        if (callCount === 1) {
          return new HttpResponse("azure transient 500", { status: 500 });
        }
        return new HttpResponse(FAKE_MP3, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      }),
    );

    const project = createTestProject(PROJECT_ID, [makeScene({ index: 1 })]);
    const result = await synthesizeAll(project);

    expect(callCount).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.scenes[0].audioPath).toBe("assets/scene-1.mp3");
  });

  it("collects a failure when one scene exhausts all retries", async () => {
    const perSceneCalls = new Map<string, number>();
    server.use(
      http.post(TTS_URL, async ({ request }) => {
        const body = await request.text();
        perSceneCalls.set(body, (perSceneCalls.get(body) ?? 0) + 1);
        if (body.includes("FAIL_ME")) {
          return new HttpResponse("azure still 500", { status: 500 });
        }
        return new HttpResponse(FAKE_MP3, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      }),
    );

    const project = createTestProject(PROJECT_ID, [
      makeScene({ index: 1, narration: "good narration" }),
      makeScene({ index: 2, narration: "FAIL_ME bad narration" }),
      makeScene({ index: 3, narration: "also good" }),
    ]);

    const result = await synthesizeAll(project);

    expect(result.scenes).toHaveLength(3);
    expect(result.scenes[0].audioPath).toBe("assets/scene-1.mp3");
    expect(result.scenes[1].audioPath).toBeNull(); // bad scene unchanged
    expect(result.scenes[2].audioPath).toBe("assets/scene-3.mp3");

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].index).toBe(2);
    expect(result.failures[0].sceneId).toBe(result.scenes[1].sceneId);
    expect(result.failures[0].error.message).toMatch(/TTS failed/);

    // The failing scene should have been retried exactly 3 times.
    const failingBody = [...perSceneCalls.keys()].find((b) =>
      b.includes("FAIL_ME"),
    );
    expect(failingBody).toBeDefined();
    expect(perSceneCalls.get(failingBody!)).toBe(3);
  });

  it("throws TTS_PROVIDER_UNCONFIGURED and never hits the network when AZURE_SPEECH_KEY is absent", async () => {
    delete process.env.AZURE_SPEECH_KEY;
    let called = false;
    server.use(
      http.post(TTS_URL, () => {
        called = true;
        return new HttpResponse(FAKE_MP3, { status: 200 });
      }),
    );

    const project = createTestProject(PROJECT_ID, [makeScene({ index: 1 })]);

    await expect(synthesizeAll(project)).rejects.toMatchObject({
      code: ErrorCode.TTS_PROVIDER_UNCONFIGURED,
    });
    expect(called).toBe(false);
  });

  it("throws TTS_PROVIDER_UNCONFIGURED when AZURE_SPEECH_ENDPOINT is absent", async () => {
    delete process.env.AZURE_SPEECH_ENDPOINT;
    const project = createTestProject(PROJECT_ID, [makeScene({ index: 1 })]);
    await expect(synthesizeAll(project)).rejects.toBeInstanceOf(WorkbenchError);
    await expect(synthesizeAll(project)).rejects.toMatchObject({
      code: ErrorCode.TTS_PROVIDER_UNCONFIGURED,
    });
  });
});

describe("synthesizeOne", () => {
  it("synthesizes a single scene and returns the updated scene", async () => {
    server.use(
      http.post(TTS_URL, () =>
        new HttpResponse(FAKE_MP3, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        }),
      ),
    );

    const scenes = [
      makeScene({ index: 1 }),
      makeScene({ index: 2 }),
    ];
    const project = createTestProject(PROJECT_ID, scenes);

    const updated = await synthesizeOne(project, scenes[1].sceneId);

    expect(updated.sceneId).toBe(scenes[1].sceneId);
    expect(updated.audioPath).toBe("assets/scene-2.mp3");
    // Only scene-2.mp3 should be on disk — scene-1 untouched.
    const written = await readFile(sceneMp3Abs(PROJECT_ID, 2));
    expect(Buffer.compare(written, FAKE_MP3)).toBe(0);
  });

  it("throws SCENE_NOT_FOUND when the sceneId does not exist", async () => {
    let called = false;
    server.use(
      http.post(TTS_URL, () => {
        called = true;
        return new HttpResponse(FAKE_MP3, { status: 200 });
      }),
    );

    const project = createTestProject(PROJECT_ID, [makeScene({ index: 1 })]);

    await expect(
      synthesizeOne(project, "sc_ffffffff"),
    ).rejects.toMatchObject({
      code: ErrorCode.SCENE_NOT_FOUND,
    });
    expect(called).toBe(false);
  });
});
