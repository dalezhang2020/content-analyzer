/**
 * Integration tests for `ai-generator.ts` with a mocked `kiro-cli` child
 * process. Covers happy paths, JSON-parse retry, tolerance retry, code-
 * fence stripping, and a non-zero-exit short-circuit.
 *
 * _Validates: Requirements 4.1, 4.2, 4.3, 4.7, 5.1, 5.3, 5.4, 5.5, 6.1,
 * 7.1, 7.7, 14.9_
 *
 * Uses tmp-dir + `process.chdir` so the per-stage logger's writes under
 * `data/projects/{id}/logs/` land inside the sandbox.
 */

import { EventEmitter } from "node:events";
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

import { createTmpDir, type TmpDir } from "@/test/fixtures/tmp-dir";
import { ErrorCode, isWorkbenchError } from "@/lib/workbench/errors";
import type {
  Brief,
  Project,
  Scene,
  Stage,
  StageStatusMap,
} from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// vi.mock("node:child_process") — fake spawn that scripts the kiro-cli
// reply per invocation.
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

interface ScriptedReply {
  /** Raw content that kiro-cli would print between the banner and the
   *  `▸ Credits:` footer. Wrapped in decorations automatically. */
  reply: string;
  /** Override the exit code. Defaults to 0. */
  exitCode?: number;
  /** Skip the banner/footer wrapping and emit this raw stdout verbatim. */
  raw?: string;
}

const hoisted = vi.hoisted(() => ({
  script: [] as ScriptedReply[],
  calls: [] as Array<{
    args: readonly string[];
    stdin: string;
    env?: NodeJS.ProcessEnv;
  }>,
}));

const scriptQueue = hoisted.script;
const spawnCalls = hoisted.calls;

function wrapKiroOutput(reply: string): string {
  // Mirror kiro-cli v2.2.2's no-interactive layout (with ANSI codes
  // included so `stripAnsi` in the SUT has something to chew on).
  const banner =
    "\u001b[32mAll tools are now trusted (\u001b[0m\u001b[31m!\u001b[0m\u001b[32m). Kiro will execute tools without asking for confirmation.\u001b[0m\n" +
    "Agents can sometimes do unexpected things so understand the risks.\n\n" +
    "Learn more at \u001b[38;5;141mhttps://kiro.dev/docs/cli/chat/security/#using-tools-trust-all-safely\u001b[0m\n\n\n" +
    "\u001b[38;5;252m\u001b[0m\u001b[?25l\u001b[38;5;141m> \u001b[0m";
  const footer =
    "\u001b[0m\u001b[0m\n\u001b[38;5;8m\n \u25b8 **Credits:** 0.37 • **Time:** 1s\n\n\u001b[0m\u001b[1G\u001b[0m\u001b[0m\u001b[?25h";
  return banner + reply + footer;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  const spawn = vi.fn(
    (
      _cmd: string,
      args: readonly string[],
      opts?: { env?: NodeJS.ProcessEnv },
    ) => {
      const child = new EventEmitter() as FakeChild;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => true);

      // Record invocation. The SUT writes the prompt to stdin then ends it;
      // we capture by draining the PassThrough.
      const stdinChunks: Buffer[] = [];
      child.stdin.on("data", (c: Buffer) => stdinChunks.push(c));
      child.stdin.on("end", () => {
        hoisted.calls.push({
          args,
          stdin: Buffer.concat(stdinChunks).toString("utf8"),
          env: opts?.env,
        });

        // Script shifts are driven off `stdin.end`, which is when the SUT
        // is done writing and really wants output.
        const next = hoisted.script.shift() ?? {
          reply: "",
          exitCode: 1,
        };
        const output =
          typeof next.raw === "string" ? next.raw : wrapKiroOutput(next.reply);
        child.stdout.end(output);
        child.stderr.end();
        const code = next.exitCode ?? 0;
        // Schedule exit on the next microtask so the SUT's "exit" listener
        // attached synchronously after spawn() is in place.
        void Promise.resolve().then(() => {
          child.exitCode = code;
          child.emit("exit", code, null);
        });
      });

      return child;
    },
  );

  return {
    ...actual,
    spawn,
    default: { ...(actual as unknown as { default?: object }).default, spawn },
  };
});

// Imports below must come AFTER vi.mock so the mocked spawn is picked up.
import {
  generateBrief,
  generateCompositionHtml,
  generateStoryboardFromBrief,
  rewriteScene,
} from "@/lib/workbench/ai-generator";

// ---------------------------------------------------------------------------
// Per-test tmp dir + cwd
// ---------------------------------------------------------------------------

let tmp: TmpDir;
let originalCwd: string;

beforeEach(async () => {
  tmp = await createTmpDir("ai-generator-");
  originalCwd = process.cwd();
  process.chdir(tmp.path);
  scriptQueue.length = 0;
  spawnCalls.length = 0;
});

afterEach(async () => {
  process.chdir(originalCwd);
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
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

const PROJECT_ID = "proj_1700000000000_abc123";

function createTestProject(overrides: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    title: "Test Project",
    topic: "why the JVM still matters in 2024",
    locale: "zh-CN",
    stage: "topic",
    stageStatus: pendingStageMap(),
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
    templateSource: {
      name: "linear-launch",
      version: "1.0.0",
      sourcePath: path.resolve(tmp.path, "templates/linear-launch"),
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const VALID_BRIEF: Brief = {
  title: "Test",
  audience: "Devs",
  corePoints: ["a", "b", "c"],
  tone: "casual",
  targetDurationSec: 60,
  suggestedStyle: "minimal",
};

/** Add scripted replies to the queue (next call → first entry, etc.). */
function queueReplies(...items: ScriptedReply[]): void {
  scriptQueue.push(...items);
}

// ---------------------------------------------------------------------------
// generateBrief
// ---------------------------------------------------------------------------

describe("generateBrief", () => {
  it("returns a parsed Brief when kiro-cli returns valid JSON", async () => {
    queueReplies({ reply: JSON.stringify(VALID_BRIEF) });

    const project = createTestProject();
    const brief = await generateBrief(project);

    expect(brief).toEqual(VALID_BRIEF);
    expect(spawnCalls).toHaveLength(1);
    // Flattened prompt should contain the topic as user content.
    expect(spawnCalls[0].stdin).toContain("why the JVM still matters");
    expect(spawnCalls[0].args).toContain("chat");
    expect(spawnCalls[0].args).toContain("--no-interactive");
  });

  it("retries on malformed JSON and returns the Brief from a later attempt", async () => {
    queueReplies(
      { reply: "this is not JSON at all {{{" },
      { reply: JSON.stringify(VALID_BRIEF) },
    );

    const project = createTestProject();
    const brief = await generateBrief(project);

    expect(spawnCalls).toHaveLength(2);
    expect(brief).toEqual(VALID_BRIEF);
  });

  it("throws LLM_OUTPUT_INVALID with a snippet after all 3 attempts fail", async () => {
    queueReplies(
      { reply: "not json {{{" },
      { reply: "still not json {{{" },
      { reply: "nope {{{" },
    );

    const project = createTestProject();

    await expect(generateBrief(project)).rejects.toSatisfy((err: unknown) => {
      if (!isWorkbenchError(err)) return false;
      if (err.code !== ErrorCode.LLM_OUTPUT_INVALID) return false;
      const details = err.details as { snippet?: unknown } | undefined;
      return typeof details?.snippet === "string" && details.snippet.length > 0;
    });
    expect(spawnCalls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// generateStoryboardFromBrief
// ---------------------------------------------------------------------------

describe("generateStoryboardFromBrief", () => {
  it("returns scenes on the happy path (total duration within ±15%)", async () => {
    // target 60s, tolerance [51, 69]; 3 × 20s = 60s exactly.
    const scenes = [
      { title: "Intro", narration: "hello", durationSec: 20, voice: "alloy" },
      { title: "Body", narration: "middle", durationSec: 20, voice: "alloy" },
      { title: "Outro", narration: "goodbye", durationSec: 20, voice: "alloy" },
    ];
    queueReplies({ reply: JSON.stringify({ scenes }) });

    const project = createTestProject({ brief: VALID_BRIEF, stage: "brief" });
    const result = await generateStoryboardFromBrief(project);

    expect(result.scenes).toEqual(scenes);
    expect(result.warning).toBeUndefined();
    expect(spawnCalls).toHaveLength(1);
  });

  it("retries when first attempt's total duration is outside tolerance", async () => {
    // Attempt 1: 3 × 10s = 30s → outside [51, 69] tolerance for target 60.
    // Attempt 2: 3 × 20s = 60s → in-tolerance.
    const outOfTolerance = [
      { title: "A", narration: "a", durationSec: 10, voice: "alloy" },
      { title: "B", narration: "b", durationSec: 10, voice: "alloy" },
      { title: "C", narration: "c", durationSec: 10, voice: "alloy" },
    ];
    const inTolerance = [
      { title: "A", narration: "a", durationSec: 20, voice: "alloy" },
      { title: "B", narration: "b", durationSec: 20, voice: "alloy" },
      { title: "C", narration: "c", durationSec: 20, voice: "alloy" },
    ];
    queueReplies(
      { reply: JSON.stringify({ scenes: outOfTolerance }) },
      { reply: JSON.stringify({ scenes: inTolerance }) },
    );

    const project = createTestProject({ brief: VALID_BRIEF, stage: "brief" });
    const result = await generateStoryboardFromBrief(project);

    expect(spawnCalls).toHaveLength(2);
    expect(result.scenes).toEqual(inTolerance);
    expect(result.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateCompositionHtml
// ---------------------------------------------------------------------------

describe("generateCompositionHtml", () => {
  it("returns HTML and strips surrounding code fences", async () => {
    const html = '<!doctype html>\n<html><body>hello</body></html>';
    // Wrap in ```html ... ``` fences the way LLMs sometimes return them.
    queueReplies({ reply: '```html\n' + html + '\n```' });

    const scenes: Scene[] = [
      {
        sceneId: "sc_abcd0001",
        index: 1,
        title: "Intro",
        narration: "hello",
        durationSec: 5,
        voice: "zh-CN-XiaoxiaoNeural",
        audioPath: null,
        qaNote: "",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ];
    const project = createTestProject({
      brief: VALID_BRIEF,
      storyboard: { scenes },
      stage: "storyboard",
    });

    const result = await generateCompositionHtml(project);

    expect(result.startsWith("<!doctype")).toBe(true);
    expect(result).toContain("<html>");
    expect(result).not.toContain("```");
  });
});

// ---------------------------------------------------------------------------
// rewriteScene
// ---------------------------------------------------------------------------

describe("rewriteScene", () => {
  const targetScene: Scene = {
    sceneId: "sc_abcd0001",
    index: 1,
    title: "Intro",
    narration: "original narration for the scene",
    durationSec: 10,
    voice: "zh-CN-XiaoxiaoNeural",
    audioPath: null,
    qaNote: "",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  it("returns the parsed rewrite output on the happy path", async () => {
    const payload = {
      narration: "rewritten narration with more punch",
      durationSec: 12,
    };
    queueReplies({ reply: JSON.stringify(payload) });

    const project = createTestProject({
      brief: VALID_BRIEF,
      storyboard: { scenes: [targetScene] },
      stage: "qa",
    });

    const result = await rewriteScene(project, targetScene, "tighten this up");

    expect(result).toEqual(payload);
  });

  it("throws LLM_OUTPUT_INVALID on malformed JSON without retrying", async () => {
    queueReplies({ reply: "not json {{{" });

    const project = createTestProject({
      brief: VALID_BRIEF,
      storyboard: { scenes: [targetScene] },
      stage: "qa",
    });

    await expect(
      rewriteScene(project, targetScene, "tighten this up"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isWorkbenchError(err) && err.code === ErrorCode.LLM_OUTPUT_INVALID,
    );
    // Per Req 7.7 — no automatic retry on rewrite failure.
    expect(spawnCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// kiro-cli non-zero exit
// ---------------------------------------------------------------------------

describe("kiro-cli process failure", () => {
  it("throws LLM_OUTPUT_INVALID when kiro-cli exits non-zero on every attempt", async () => {
    // All 3 brief attempts fail with exit code 1. The SUT's LLM_OUTPUT_INVALID
    // from each attempt is retried until the budget is exhausted, at which
    // point the final attempt's error propagates.
    queueReplies(
      { reply: "auth failure", exitCode: 1, raw: "" },
      { reply: "auth failure", exitCode: 1, raw: "" },
      { reply: "auth failure", exitCode: 1, raw: "" },
    );

    const project = createTestProject();

    await expect(generateBrief(project)).rejects.toSatisfy(
      (err: unknown) =>
        isWorkbenchError(err) && err.code === ErrorCode.LLM_OUTPUT_INVALID,
    );
    expect(spawnCalls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Property 18: LLM retry respects the configured attempt budget
// ---------------------------------------------------------------------------
//
// Validates: Requirements 4.3, 4.4, 5.5, 5.6, 7.7
//
// For each of the four AI tasks, fast-check explores every combination of
// scripted LLM outcomes (valid / malformed / out-of-tolerance) and asserts
// the spawn-invocation count stays within the documented retry budget:
//
//   generateBrief                — budget 3 total attempts (Req 4.3/4.4)
//   generateStoryboardFromBrief  — budget 2 total attempts (Req 5.5/5.6)
//   generateCompositionHtml      — 1 spawn per call; caller repair loop
//                                  bounds total to 2 (design §LLM contracts)
//   rewriteScene                 — exactly 1 attempt, zero retry (Req 7.7)
//
// Each property runs ≥ 30 iterations so every outcome permutation for the
// small budgets (2^3 = 8 for brief, 3^2 = 9 for storyboard) is easily
// exhausted under fast-check's default shrinking.

import fc from "fast-check";

describe("Property 18: LLM retry respects the configured attempt budget", () => {
  // -------------------------------------------------------------------------
  // Shared fixture helpers
  // -------------------------------------------------------------------------

  const validBriefReply = JSON.stringify(VALID_BRIEF);
  const malformedReply = "this is not JSON {{{";

  /** Storyboard output with scenes summing to 60s — inside the ±15% band
   *  (tolerance window [51, 69]) for VALID_BRIEF.targetDurationSec = 60. */
  const scenesInTolerance = [
    { title: "Intro", narration: "hello", durationSec: 20, voice: "alloy" },
    { title: "Body", narration: "middle", durationSec: 20, voice: "alloy" },
    { title: "Outro", narration: "goodbye", durationSec: 20, voice: "alloy" },
  ];

  /** Storyboard output with scenes summing to 30s — outside the ±15% band
   *  (30 < 51) so the tolerance-retry branch fires. */
  const scenesOutOfTolerance = [
    { title: "A", narration: "a", durationSec: 10, voice: "alloy" },
    { title: "B", narration: "b", durationSec: 10, voice: "alloy" },
    { title: "C", narration: "c", durationSec: 10, voice: "alloy" },
  ];

  /** Reset the scripted-reply queue and the spawn-invocation log before
   *  each fast-check iteration. The top-level `beforeEach` already does
   *  this for plain test cases, but fast-check runs multiple property
   *  samples per test — each needs a clean queue. */
  function resetHarness(): void {
    scriptQueue.length = 0;
    spawnCalls.length = 0;
  }

  // -------------------------------------------------------------------------
  // generateBrief — budget 3
  // -------------------------------------------------------------------------

  type BriefOutcome = "valid" | "malformed";
  const briefOutcomeArb = fc.constantFrom<BriefOutcome>("valid", "malformed");

  it("generateBrief: at most 3 attempts; stops at the first valid reply", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Exactly 3 scripted outcomes — the budget ceiling. fast-check
        // explores all 2^3 = 8 permutations.
        fc.array(briefOutcomeArb, { minLength: 3, maxLength: 3 }),
        async (outcomes) => {
          resetHarness();

          for (const o of outcomes) {
            queueReplies({
              reply: o === "valid" ? validBriefReply : malformedReply,
            });
          }

          const project = createTestProject();
          const firstValidIdx = outcomes.indexOf("valid");

          if (firstValidIdx === -1) {
            // All 3 malformed → budget exhausted → throws.
            await expect(generateBrief(project)).rejects.toSatisfy(
              (err: unknown) =>
                isWorkbenchError(err) &&
                err.code === ErrorCode.LLM_OUTPUT_INVALID,
            );
            expect(spawnCalls).toHaveLength(3);
          } else {
            // Returns on first valid parse — no further spawns.
            const brief = await generateBrief(project);
            expect(brief).toEqual(VALID_BRIEF);
            expect(spawnCalls).toHaveLength(firstValidIdx + 1);
          }

          // Core property: spawn count NEVER exceeds the budget (Req 4.3).
          expect(spawnCalls.length).toBeLessThanOrEqual(3);
          expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 30 },
    );
  });

  // -------------------------------------------------------------------------
  // generateStoryboardFromBrief — budget 2 (tolerance OR schema retry)
  // -------------------------------------------------------------------------

  type StoryboardOutcome = "in-tolerance" | "out-of-tolerance" | "invalid";
  const storyboardOutcomeArb = fc.constantFrom<StoryboardOutcome>(
    "in-tolerance",
    "out-of-tolerance",
    "invalid",
  );

  function storyboardReplyFor(o: StoryboardOutcome): ScriptedReply {
    if (o === "in-tolerance")
      return { reply: JSON.stringify({ scenes: scenesInTolerance }) };
    if (o === "out-of-tolerance")
      return { reply: JSON.stringify({ scenes: scenesOutOfTolerance }) };
    return { reply: malformedReply };
  }

  it("generateStoryboardFromBrief: at most 2 attempts regardless of outcome mix", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Budget = 2 total attempts. fast-check explores all 3^2 = 9
        // permutations of (outcome₁, outcome₂).
        fc.array(storyboardOutcomeArb, { minLength: 2, maxLength: 2 }),
        async (outcomes) => {
          resetHarness();

          for (const o of outcomes) queueReplies(storyboardReplyFor(o));

          const project = createTestProject({
            brief: VALID_BRIEF,
            stage: "brief",
          });

          // Outcome is EITHER success (possibly with warning) when at least
          // one attempt produced valid schema, OR throws when both attempts
          // failed schema/parse. Budget is the same in both branches.
          try {
            const result = await generateStoryboardFromBrief(project);
            expect(Array.isArray(result.scenes)).toBe(true);

            // First attempt in-tolerance short-circuits to 1 spawn.
            if (outcomes[0] === "in-tolerance") {
              expect(spawnCalls).toHaveLength(1);
              expect(result.warning).toBeUndefined();
            }
          } catch (err) {
            // Both attempts failed schema/parse → throws LLM_OUTPUT_INVALID.
            expect(isWorkbenchError(err)).toBe(true);
            expect((err as WorkbenchError).code).toBe(
              ErrorCode.LLM_OUTPUT_INVALID,
            );
            expect(outcomes.every((o) => o === "invalid")).toBe(true);
            expect(spawnCalls).toHaveLength(2);
          }

          // Core property: never more than 2 spawns (Req 5.5/5.6).
          expect(spawnCalls.length).toBeLessThanOrEqual(2);
          expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 30 },
    );
  });

  // -------------------------------------------------------------------------
  // generateCompositionHtml — 1 spawn per call; repair loop bounded to 2
  // -------------------------------------------------------------------------

  /** Scene fixture reused across composition / rewrite properties. */
  const compositionScene: Scene = {
    sceneId: "sc_abcd0001",
    index: 1,
    title: "Intro",
    narration: "hello",
    durationSec: 5,
    voice: "zh-CN-XiaoxiaoNeural",
    audioPath: null,
    qaNote: "",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  it("generateCompositionHtml: 1 spawn per invocation; caller repair loop ≤ 2 total", async () => {
    await fc.assert(
      fc.asyncProperty(
        // doRepair drives the second (repair) invocation. bodyVariant is
        // only there to vary the scripted HTML so the test exercises
        // different outputs — the retry budget itself is independent of
        // the HTML content.
        fc.boolean(),
        fc.boolean(),
        async (doRepair, bodyVariant) => {
          resetHarness();

          const firstHtml = bodyVariant
            ? "<!doctype html>\n<html><body>first variant</body></html>"
            : "<!doctype html>\n<html><body>hello</body></html>";
          const repairHtml =
            "<!doctype html>\n<html><body>repaired</body></html>";

          queueReplies(
            { reply: firstHtml },
            { reply: repairHtml },
          );

          const project = createTestProject({
            brief: VALID_BRIEF,
            storyboard: { scenes: [compositionScene] },
            stage: "storyboard",
          });

          const out1 = await generateCompositionHtml(project);
          expect(out1.startsWith("<!doctype")).toBe(true);
          // Single invocation → exactly 1 spawn (no internal retry).
          expect(spawnCalls).toHaveLength(1);

          if (doRepair) {
            // Simulate the route-level repair loop: caller re-invokes
            // with `lintError` populated after lint/validate fails once.
            const out2 = await generateCompositionHtml(
              project,
              "lint error: missing class=\"clip\"",
            );
            expect(out2.startsWith("<!doctype")).toBe(true);
            // After the single repair retry the total is 2 spawns — the
            // documented upper bound for the composition stage.
            expect(spawnCalls).toHaveLength(2);
          }

          // Core property: total spawns never exceed the 2-attempt budget.
          expect(spawnCalls.length).toBeLessThanOrEqual(2);
        },
      ),
      { numRuns: 30 },
    );
  });

  // -------------------------------------------------------------------------
  // rewriteScene — exactly 1 attempt, zero retry (Req 7.7)
  // -------------------------------------------------------------------------

  it("rewriteScene: exactly 1 attempt whether the reply is valid or malformed", async () => {
    const validRewrite = {
      narration: "rewritten narration with more punch",
      durationSec: 12,
    };

    await fc.assert(
      fc.asyncProperty(
        // Vary the reply between valid JSON and malformed so the property
        // covers both the happy path and the schema-fail throw path.
        fc.boolean(),
        async (makeValid) => {
          resetHarness();

          queueReplies({
            reply: makeValid ? JSON.stringify(validRewrite) : malformedReply,
          });

          const project = createTestProject({
            brief: VALID_BRIEF,
            storyboard: { scenes: [compositionScene] },
            stage: "qa",
          });

          if (makeValid) {
            const result = await rewriteScene(
              project,
              compositionScene,
              "tighten this up",
            );
            expect(result).toEqual(validRewrite);
          } else {
            await expect(
              rewriteScene(project, compositionScene, "tighten this up"),
            ).rejects.toSatisfy(
              (err: unknown) =>
                isWorkbenchError(err) &&
                err.code === ErrorCode.LLM_OUTPUT_INVALID,
            );
          }

          // Core property: exactly 1 spawn in EVERY branch — no retry on
          // schema failure per Req 7.7.
          expect(spawnCalls).toHaveLength(1);
        },
      ),
      { numRuns: 30 },
    );
  });
});
