/**
 * Video Creation Workbench — mocked E2E smoke test (T50).
 *
 * Walks topic → brief → storyboard → composition → audio → render →
 * publish by invoking each Route Handler's exported `POST` directly. No
 * browser, no dev server. spawn(kiro-cli) is mocked for LLM calls; MSW
 * mocks Azure TTS;
 * `vi.mock("node:child_process", ...)` mocks the hyperframes CLI
 * (lint/validate auto-succeed; render is driven manually).
 *
 * _Validates: Requirements 17.1–17.7_
 */

import { EventEmitter } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

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

// `vi.mock` factories are hoisted above top-level `const`/`let`, so any
// state they reference must go through `vi.hoisted`. See
// render-service.test.ts for the same idiom.
interface FakeChild extends EventEmitter {
  stdin?: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => ({
  children: [] as Array<
    EventEmitter & {
      stdin?: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
    }
  >,
  calls: [] as Array<{ cmd: string; args: readonly string[]; cwd?: string }>,
  // FIFO queue of scripted replies for kiro-cli invocations. Each entry
  // is the raw text that should appear between the kiro-cli banner and
  // the " ▸ Credits:" footer (the SUT's `extractKiroReply` strips both).
  kiroScript: [] as Array<{ reply: string; exitCode?: number }>,
}));

function wrapKiroOutput(reply: string): string {
  // Mirrors kiro-cli v2.2.2's --no-interactive layout (ANSI codes included
  // so the SUT's stripAnsi has something to process).
  const banner =
    "\u001b[32mAll tools are now trusted.\u001b[0m\n" +
    "Learn more…\n\n\n" +
    "\u001b[38;5;141m> \u001b[0m";
  const footer =
    "\u001b[0m\n \u25b8 **Credits:** 0.01 • **Time:** 1s\n\n\u001b[0m";
  return banner + reply + footer;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = vi.fn(
    (cmd: string, args: readonly string[], opts?: { cwd?: string }) => {
      const child = new EventEmitter() as FakeChild;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => true);
      hoisted.children.push(child);
      hoisted.calls.push({ cmd, args, cwd: opts?.cwd });

      // `kiro-cli chat` — feed scripted reply off stdin.end().
      if (args.includes("chat") && args.includes("--no-interactive")) {
        // Drain stdin so the SUT's `stdin.end()` resolves. We don't care
        // about the prompt content here — the scripted reply is pre-queued.
        child.stdin.on("data", () => {
          /* drain */
        });
        child.stdin.on("end", () => {
          const next = hoisted.kiroScript.shift() ?? {
            reply: "",
            exitCode: 1,
          };
          child.stdout.end(wrapKiroOutput(next.reply));
          child.stderr.end();
          const code = next.exitCode ?? 0;
          void Promise.resolve().then(() => {
            child.exitCode = code;
            child.emit("exit", code, null);
          });
        });
        return child;
      }

      // hyperframes lint/validate — auto-succeed on next microtask.
      if (args.includes("lint") || args.includes("validate")) {
        void Promise.resolve().then(() => {
          child.stdout.end();
          child.stderr.end();
          child.exitCode = 0;
          child.emit("exit", 0, null);
        });
        return child;
      }

      // hyperframes render — left manual; the test drives exit.
      return child;
    },
  );
  // Cover both named export AND default.spawn — Vite's CJS/ESM interop
  // resolves `import { spawn } from "node:child_process"` through
  // `default.spawn`.
  return {
    ...actual,
    spawn,
    default: { ...(actual as unknown as { default?: object }).default, spawn },
  };
});

// Mock template-manager so POST /api/projects doesn't try to resolve the
// real linear-launch sibling directory. The composition route writes its
// own index.html later, so the template deep-copy can be a no-op.
vi.mock("@/lib/workbench/template-manager", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/workbench/template-manager")>();
  return {
    ...actual,
    getTemplateSource: vi.fn(async () => ({
      name: "linear-launch",
      version: "0.0.0-test",
      sourcePath: "/mock-template-source",
    })),
    deepCopyTemplate: vi.fn(async () => {
      /* no-op */
    }),
  };
});

// Route handler imports MUST come after vi.mock so the mocks are active.
import * as ProjectsRoute from "@/app/api/projects/route";
import * as ProjectRoute from "@/app/api/projects/[id]/route";
import * as BriefRoute from "@/app/api/projects/[id]/brief/generate/route";
import * as StoryboardRoute from "@/app/api/projects/[id]/storyboard/generate/route";
import * as CompositionRoute from "@/app/api/projects/[id]/composition/generate/route";
import * as AudioRoute from "@/app/api/projects/[id]/audio/generate/route";
import * as RenderRoute from "@/app/api/projects/[id]/render/route";
import * as PublishRoute from "@/app/api/projects/[id]/publish/route";
import { VIDEO_DIR } from "@/lib/workbench/constants";

// MSW lifecycle (inlined — also resets handlers per test).
beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const AZURE_ENDPOINT = "https://azure.test.example.com";
const AZURE_TTS_URL = `${AZURE_ENDPOINT}/cognitiveservices/v1`;
const FAKE_MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00]);

let tmp: TmpDir;
let originalCwd: string;
let setTimeoutSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(async () => {
  hoisted.children.length = 0;
  hoisted.calls.length = 0;
  hoisted.kiroScript.length = 0;
  tmp = await createTmpDir("workbench-e2e-");
  originalCwd = process.cwd();
  process.chdir(tmp.path);

  // LLM is served by the mocked kiro-cli spawn — no API keys needed.
  process.env.AZURE_SPEECH_ENDPOINT = AZURE_ENDPOINT;
  process.env.AZURE_SPEECH_KEY = "azure-key-123456";

  // Collapse short setTimeout delays (TTS backoffs, SSE heartbeat) so the
  // walk runs in milliseconds. Longer delays (abort timers at 60s+) pass
  // through untouched. Same pattern as tts-service.test.ts.
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
  // Finalize any still-running fake child so render-service's module-level
  // timers don't leak into the next test.
  for (const child of hoisted.children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    }
  }
});

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const VALID_BRIEF = {
  title: "Test Brief",
  audience: "Developers",
  corePoints: ["point one", "point two", "point three"],
  tone: "casual",
  targetDurationSec: 60,
  suggestedStyle: "minimal",
};

const VALID_STORYBOARD_SCENES = [
  { title: "Intro", narration: "Welcome", durationSec: 20, voice: "zh-CN-XiaoxiaoNeural" },
  { title: "Body", narration: "Main content", durationSec: 20, voice: "zh-CN-XiaoxiaoNeural" },
  { title: "Outro", narration: "Thanks", durationSec: 20, voice: "zh-CN-XiaoxiaoNeural" },
];

const VALID_COMPOSITION_HTML =
  '<!doctype html>\n<html><head><title>t</title></head><body>' +
  '<div class="clip" data-start="0" data-duration="20" data-track-index="0">s1</div>' +
  '<div class="clip" data-start="20" data-duration="20" data-track-index="0">s2</div>' +
  '<div class="clip" data-start="40" data-duration="20" data-track-index="0">s3</div>' +
  "</body></html>";

/** Queue the three scripted kiro-cli replies used by the walk:
 *  brief → storyboard → composition HTML. The mocked spawn in the
 *  hoisted factory consumes entries in FIFO order, one per invocation. */
function queueKiroReplies(): void {
  hoisted.kiroScript.push(
    { reply: JSON.stringify(VALID_BRIEF) },
    { reply: JSON.stringify({ scenes: VALID_STORYBOARD_SCENES }) },
    { reply: VALID_COMPOSITION_HTML },
  );
}

function installAzureHandler(): void {
  server.use(
    http.post(AZURE_TTS_URL, () =>
      new HttpResponse(FAKE_MP3, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      }),
    ),
  );
}

const req = (url: string, init?: RequestInit): Request =>
  new Request(`http://test${url}`, init);

/** Next.js 16 wraps params in a Promise. */
const ctx = (projectId: string) => ({
  params: Promise.resolve({ id: projectId }),
});

async function readProjectJson(
  projectId: string,
): Promise<Record<string, unknown>> {
  const res = await ProjectRoute.GET(req(`/api/projects/${projectId}`), ctx(projectId));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** Poll GET /api/projects/{id} until project.stage === expected. */
async function waitForStage(
  projectId: string,
  expected: string,
  maxMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await ProjectRoute.GET(
      req(`/api/projects/${projectId}`),
      ctx(projectId),
    );
    if (res.status === 200) {
      const p = (await res.json()) as { stage: string };
      if (p.stage === expected) return;
    }
    await new Promise<void>((r) => setTimeout(r, 20));
  }
  throw new Error(`waitForStage(${expected}) timed out for ${projectId}`);
}

async function writeOutputMp4(projectId: string): Promise<void> {
  const abs = path.resolve(tmp.path, VIDEO_DIR, `project-${projectId}.mp4`);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.alloc(128, 0x41));
}

// ---------------------------------------------------------------------------
// The smoke test
// ---------------------------------------------------------------------------

describe("workbench E2E smoke (mocked)", () => {
  it(
    "walks topic → brief → storyboard → composition → audio → render → published",
    async () => {
      queueKiroReplies();
      installAzureHandler();

      // Step 1: create project.
      const createRes = await ProjectsRoute.POST(
        req("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "E2E Test",
            topic: "What is Kiro and why does it matter?",
          }),
        }) as never,
      );
      expect(createRes.status).toBe(201);
      const { projectId } = (await createRes.json()) as { projectId: string };

      /** Call a POST route handler at /api/projects/{id}/<suffix>. */
      const post = (
        route: {
          POST: (req: never, c: { params: Promise<{ id: string }> }) => Promise<Response>;
        },
        suffix: string,
      ) =>
        route.POST(
          req(`/api/projects/${projectId}${suffix}`, { method: "POST" }) as never,
          ctx(projectId),
        );

      // Step 2: brief.
      expect((await post(BriefRoute, "/brief/generate")).status).toBe(200);
      let project = await readProjectJson(projectId);
      expect(project.stage).toBe("brief");
      expect(project.brief).toMatchObject({ title: "Test Brief" });

      // Step 3: storyboard.
      expect((await post(StoryboardRoute, "/storyboard/generate")).status).toBe(200);
      project = await readProjectJson(projectId);
      expect(project.stage).toBe("storyboard");
      expect((project.storyboard as { scenes: unknown[] }).scenes).toHaveLength(3);

      // Step 4: composition.
      expect((await post(CompositionRoute, "/composition/generate")).status).toBe(200);
      project = await readProjectJson(projectId);
      expect(project.stage).toBe("composition");
      expect((project.artifacts as { indexHtmlPath: string }).indexHtmlPath).toBe(
        "composition/index.html",
      );

      // Step 5: audio.
      expect((await post(AudioRoute, "/audio/generate")).status).toBe(200);
      project = await readProjectJson(projectId);
      expect(project.stage).toBe("audio");
      expect((project.artifacts as { audioPaths: string[] }).audioPaths).toEqual([
        "assets/scene-1.mp3",
        "assets/scene-2.mp3",
        "assets/scene-3.mp3",
      ]);

      // Step 6: render. 202 returns immediately; drive the subprocess to
      // success so the detached state-update task advances stage → "render".
      const childrenBefore = hoisted.children.length;
      const renderRes = await post(RenderRoute, "/render");
      expect(renderRes.status).toBe(202);
      const renderPayload = (await renderRes.json()) as { runId: string; streamUrl: string };
      expect(renderPayload.runId).toMatch(/^render_/);
      expect(renderPayload.streamUrl).toBe(`/api/projects/${projectId}/render/stream`);
      expect(hoisted.children.length).toBe(childrenBefore + 1);

      await writeOutputMp4(projectId);
      const renderChild = hoisted.children[hoisted.children.length - 1];
      renderChild.exitCode = 0;
      renderChild.emit("exit", 0, null);

      await waitForStage(projectId, "render", 3_000);
      project = await readProjectJson(projectId);
      expect((project.artifacts as { videoPath: string }).videoPath).toBe(
        `/videos/project-${projectId}.mp4`,
      );

      // Step 7: publish.
      expect((await post(PublishRoute, "/publish")).status).toBe(200);
      project = await readProjectJson(projectId);
      expect(project.stage).toBe("published");

      // Final assertions: mp4 on disk, audio tags injected, every forward
      // stage succeeded, at least one hyperframes render spawn logged.
      const mp4Abs = path.resolve(tmp.path, VIDEO_DIR, `project-${projectId}.mp4`);
      expect((await stat(mp4Abs)).size).toBeGreaterThan(0);

      const htmlAbs = path.resolve(
        tmp.path,
        "data/projects",
        projectId,
        "composition/index.html",
      );
      const html = await readFile(htmlAbs, "utf8");
      expect(html).toContain('class="scene-audio"');
      expect(html).toContain('src="assets/scene-1.mp3"');

      expect(hoisted.calls.some((c) => c.args.includes("render"))).toBe(true);

      const stageStatus = project.stageStatus as Record<string, { status: string }>;
      for (const s of ["brief", "storyboard", "composition", "audio", "render"]) {
        expect(stageStatus[s].status).toBe("succeeded");
      }
    },
    30_000,
  );
});
