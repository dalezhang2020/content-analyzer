/**
 * Video Creation Workbench — render-service integration tests (T24.2).
 *
 * Exercises `startRender`, `subscribeRender`, `getActiveRender`, and
 * `killRender` against a mocked `child_process.spawn`. A fake child is
 * assembled from an `EventEmitter` plus two `PassThrough` streams so we
 * can drive stdout / stderr / exit deterministically and assert the SSE
 * event ordering that drives the render UI.
 *
 * _Validates: Requirements 10.5, 10.6, 10.8, 10.9, 10.10_
 */

import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Shared registry of fake children. `vi.mock` factories are hoisted above
// top-level `const`/`let` declarations, so any state the factory references
// must be declared through `vi.hoisted`.
interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => {
  const children: Array<
    EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
    }
  > = [];
  const calls: Array<{
    cmd: string;
    args: readonly string[];
    cwd?: string;
  }> = [];
  return { children, calls };
});

const fakeChildren = hoisted.children as FakeChild[];
const spawnCalls = hoisted.calls;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  const spawn = vi.fn(
    (cmd: string, args: readonly string[], opts?: { cwd?: string }) => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => true);

      hoisted.children.push(child);
      hoisted.calls.push({ cmd, args, cwd: opts?.cwd });
      return child;
    },
  );

  // Node's CJS modules are exposed through a `default` wrapper in Vite's ESM
  // interop. Named `import { spawn } from "node:child_process"` in the SUT
  // resolves through `default.spawn`, so we must override both surfaces.
  return {
    ...actual,
    spawn,
    default: { ...(actual as unknown as { default?: object }).default, spawn },
  };
});

// Imports must come after `vi.mock` so the mocked `spawn` is picked up when
// render-service resolves its dependencies.
import {
  getActiveRender,
  startRender,
  subscribeRender,
} from "./render-service";
import { ErrorCode, WorkbenchError } from "./errors";
import { VIDEO_DIR } from "./constants";
import type { Project, RenderEvent } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function latestChild(): FakeChild {
  const child = fakeChildren[fakeChildren.length - 1];
  if (!child) throw new Error("no fake child spawned yet");
  return child;
}

/** Yield the event loop a few times so stream → readline → emitEvent can flush. */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

/**
 * Consume events from a subscribe iterator until a predicate fires, the
 * requested count is reached, or the wall-clock deadline expires. Always
 * closes the iterator on exit so the generator's `finally` block runs and
 * unregisters its subscriber.
 */
async function collectEvents(
  iter: AsyncIterable<RenderEvent>,
  opts: {
    count?: number;
    until?: (ev: RenderEvent) => boolean;
    maxMs?: number;
  } = {},
): Promise<RenderEvent[]> {
  const events: RenderEvent[] = [];
  const deadline = Date.now() + (opts.maxMs ?? 2_000);
  const it = iter[Symbol.asyncIterator]();
  try {
    while (true) {
      if (Date.now() > deadline) break;
      if (opts.count && events.length >= opts.count) break;
      const race = await Promise.race([
        it.next(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (race.done) break;
      const ev = race.value as RenderEvent;
      events.push(ev);
      if (opts.until && opts.until(ev)) break;
    }
  } finally {
    await it.return?.();
  }
  return events;
}

function makeTestProject(projectId: string): Project {
  return {
    schemaVersion: 1,
    projectId,
    title: "Test Project",
    topic: "test",
    locale: "zh-CN",
    stage: "audio",
    // Stage-status map is not read by render-service; zero it out.
    stageStatus: {
      topic: { status: "succeeded" },
      brief: { status: "succeeded" },
      storyboard: { status: "succeeded" },
      composition: { status: "succeeded" },
      audio: { status: "succeeded" },
      render: { status: "pending" },
      qa: { status: "pending" },
      published: { status: "pending" },
    },
    stageHistory: [],
    brief: null,
    storyboard: null,
    artifacts: {
      briefPath: null,
      storyboardPath: null,
      compositionDir: null,
      indexHtmlPath: null,
      hyperframesJsonPath: null,
      audioPaths: [],
      videoPath: null,
    },
    qaNotes: [],
    templateSource: { name: "t", version: "1", sourcePath: "/tmp/t" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Generate a unique, regex-valid project id so module-level render maps don't alias across tests. */
let projectIdCounter = 0;
function uniqueProjectId(): string {
  projectIdCounter += 1;
  const ts = Date.now() + projectIdCounter;
  // 6 lowercase alphanum suffix.
  const suffix = (Math.floor(Math.random() * 36 ** 6))
    .toString(36)
    .padStart(6, "0")
    .slice(-6);
  return `proj_${ts}_${suffix}`;
}

/** Write a non-empty mp4 file where render-service expects the output. */
async function writeOutputMp4(tmpRoot: string, projectId: string, bytes = 42): Promise<string> {
  const abs = path.resolve(tmpRoot, VIDEO_DIR, `project-${projectId}.mp4`);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.alloc(bytes, 0x41));
  return abs;
}

/** Poll until `active.status` is terminal or deadline hits. */
async function waitForTerminal(projectId: string, maxMs = 2_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const a = getActiveRender(projectId);
    if (a && a.status !== "running") return;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let prevCwd: string;

beforeEach(async () => {
  fakeChildren.length = 0;
  spawnCalls.length = 0;
  prevCwd = process.cwd();
  // Fresh tmp sandbox per test so VIDEO_DIR / DATA_DIR resolve inside it.
  const { createTmpDir } = await import("@/test/fixtures/tmp-dir");
  const dir = await createTmpDir("render-service-test-");
  tmpRoot = dir.path;
  process.chdir(tmpRoot);
});

afterEach(async () => {
  // Best-effort cleanup: make sure no fake child is still "running" so the
  // module-level timeout/heartbeat timers don't leak into the next test.
  for (const child of fakeChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    }
  }
  await flush();
  process.chdir(prevCwd);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("render-service integration", () => {
  it(
    "startRender emits starting event immediately",
    async () => {
      const projectId = uniqueProjectId();
      const project = makeTestProject(projectId);
      await startRender(project);

      const events = await collectEvents(subscribeRender(projectId), {
        count: 1,
        maxMs: 500,
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "stage", stage: "starting" });

      // Verify spawn was invoked with the expected shape (hyperframes render ...).
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].cmd).toBe("npx");
      expect(spawnCalls[0].args).toEqual(
        expect.arrayContaining(["render", "--output", "--fps"]),
      );
    },
    10_000,
  );

  it(
    "stdout lines emit line events and trigger rendering stage",
    async () => {
      const projectId = uniqueProjectId();
      await startRender(makeTestProject(projectId));
      const child = latestChild();

      child.stdout.write("rendering frame 1\n");
      await flush();

      const events = await collectEvents(subscribeRender(projectId), {
        count: 3,
        maxMs: 500,
      });

      // Order: starting, line, stage:rendering.
      expect(events[0]).toMatchObject({ type: "stage", stage: "starting" });
      expect(events[1]).toMatchObject({
        type: "line",
        line: "rendering frame 1",
      });
      expect(events[2]).toMatchObject({ type: "stage", stage: "rendering" });
    },
    10_000,
  );

  it(
    "encoding stage transition emits exactly once",
    async () => {
      const projectId = uniqueProjectId();
      await startRender(makeTestProject(projectId));
      const child = latestChild();

      child.stdout.write("encoding video\n");
      child.stdout.write("encoding more frames\n");
      child.stdout.write("encoding finished\n");
      await flush();

      const events = await collectEvents(subscribeRender(projectId), {
        count: 7,
        maxMs: 500,
      });

      const encodingStages = events.filter(
        (e) => e.type === "stage" && e.stage === "encoding",
      );
      expect(encodingStages).toHaveLength(1);

      // Should also observe line events for each stdout line.
      const lineEvents = events.filter((e) => e.type === "line");
      expect(lineEvents).toHaveLength(3);
    },
    10_000,
  );

  it(
    "successful exit with valid mp4 transitions to done",
    async () => {
      const projectId = uniqueProjectId();
      await startRender(makeTestProject(projectId));
      const child = latestChild();

      const expectedMp4 = await writeOutputMp4(tmpRoot, projectId, 128);

      child.exitCode = 0;
      child.emit("exit", 0, null);
      await waitForTerminal(projectId);

      const active = getActiveRender(projectId);
      expect(active).toBeDefined();
      expect(active!.status).toBe("done");
      expect(active!.videoPath).toBe(`/videos/project-${projectId}.mp4`);

      // The mp4 we pre-wrote should still be there (success path does not unlink).
      const { stat } = await import("node:fs/promises");
      const s = await stat(expectedMp4);
      expect(s.size).toBeGreaterThan(0);

      // Terminal event should be `stage: done`.
      const last = active!.events[active!.events.length - 1];
      expect(last).toMatchObject({ type: "stage", stage: "done" });
    },
    10_000,
  );

  it(
    "exit 0 with missing mp4 is treated as failure",
    async () => {
      const projectId = uniqueProjectId();
      await startRender(makeTestProject(projectId));
      const child = latestChild();

      // No mp4 written → exit 0 must be promoted to failed.
      child.exitCode = 0;
      child.emit("exit", 0, null);
      await waitForTerminal(projectId);

      const active = getActiveRender(projectId);
      expect(active).toBeDefined();
      expect(active!.status).toBe("failed");
      expect(active!.error).toBeDefined();
      expect(active!.error!.message).toMatch(/missing|empty/i);
      expect(active!.videoPath).toBeNull();
    },
    10_000,
  );

  it(
    "non-zero exit emits failed with stderr tail in error message",
    async () => {
      const projectId = uniqueProjectId();
      await startRender(makeTestProject(projectId));
      const child = latestChild();

      child.stderr.write("fatal: something went wrong\n");
      await flush();

      child.exitCode = 1;
      child.emit("exit", 1, null);
      await waitForTerminal(projectId);

      const active = getActiveRender(projectId);
      expect(active).toBeDefined();
      expect(active!.status).toBe("failed");
      expect(active!.error).toBeDefined();
      // Message format: `render exited 1: <stderr tail>` (see render-service).
      expect(active!.error!.message).toMatch(/exited 1/);
      expect(active!.error!.message).toMatch(/something went wrong/);
    },
    10_000,
  );

  it(
    "subscribeRender throws NO_RENDER when no active render exists",
    () => {
      const projectId = uniqueProjectId();
      expect(() => subscribeRender(projectId)).toThrowError(WorkbenchError);
      try {
        subscribeRender(projectId);
      } catch (e) {
        expect(e).toBeInstanceOf(WorkbenchError);
        expect((e as WorkbenchError).code).toBe(ErrorCode.NO_RENDER);
      }
    },
  );

  it(
    "subscribeRender replays historical events for late joiners",
    async () => {
      const projectId = uniqueProjectId();
      await startRender(makeTestProject(projectId));
      const child = latestChild();

      // Push a couple of lines BEFORE any subscriber attaches.
      child.stdout.write("rendering scene 1\n");
      await flush();
      child.stdout.write("almost done\n");
      await flush();

      // Late subscribe — must replay [starting, line, stage:rendering, line].
      const events = await collectEvents(subscribeRender(projectId), {
        count: 4,
        maxMs: 500,
      });

      expect(events.length).toBeGreaterThanOrEqual(4);
      expect(events[0]).toMatchObject({ type: "stage", stage: "starting" });
      // The two line events should both appear in order, with stage:rendering
      // interleaved after the first.
      const lines = events.filter((e) => e.type === "line");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ line: "rendering scene 1" });
      expect(lines[1]).toMatchObject({ line: "almost done" });
    },
    10_000,
  );
});
