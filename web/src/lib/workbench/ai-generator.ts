/**
 * Video Creation Workbench — LLM generation tasks.
 *
 * Implements the four AI tasks defined in design §LLM Prompt Contracts:
 *   - `generateBrief`            (topic → Brief)
 *   - `generateStoryboardFromBrief` (brief → Storyboard scenes)
 *   - `generateCompositionHtml`  (storyboard → HyperFrames HTML)
 *   - `rewriteScene`             (QA note → new narration)
 *
 * Backend: local `kiro-cli chat` subprocess (Claude Sonnet/Opus by default).
 * No API keys, no network calls — the workbench is fully self-hosted via
 * the Kiro CLI already authenticated on the machine.
 *
 * Each task shares a single `callLLM` helper that owns per-call:
 *   - wall-clock timeout ⇒ `LLM_TIMEOUT` (SIGTERM on the child process)
 *   - non-zero exit      ⇒ `LLM_OUTPUT_INVALID`
 *   - empty reply        ⇒ `LLM_OUTPUT_INVALID`
 *   - structured logging via `logger.timed("llm_call", …)`
 *
 * Retry budgets come from `./constants` and match the requirements:
 *   - Brief        : 3 total attempts    (Req 4.3)
 *   - Storyboard   : 2 total attempts    (Req 5.5 — 1 tolerance retry)
 *   - Composition  : 1 attempt per call  (repair loop lives in route)
 *   - Scene rewrite: 1 attempt, no retry (Req 7.7)
 *
 * LLM response snippets embedded in error `details` are truncated to 500
 * chars. Environment overrides:
 *   KIRO_CLI_BIN  — path to the kiro-cli binary (default: "kiro-cli")
 *   KIRO_MODEL    — model id, see `kiro-cli chat --list-models`
 *                   (default: "claude-sonnet-4.6")
 *
 * _Requirements: 4.1–4.9, 5.1–5.7, 6.1–6.4, 7.1–7.3, 7.7, 14.6, 14.9_
 */

import { spawn } from "node:child_process";

import {
  DEFAULT_LOCALE,
  LIMITS,
  LLM_BRIEF_MAX_ATTEMPTS,
  LLM_STORYBOARD_MAX_ATTEMPTS,
  TIMEOUTS_MS,
} from "./constants";
import { ErrorCode, WorkbenchError } from "./errors";
import { createLogger, type WorkbenchLogger } from "./logger";
import {
  BriefSchema,
  SceneRewriteOutputSchema,
  StoryboardOutputSchema,
  type StoryboardOutput,
} from "./schemas";
import type { Brief, Project, Scene } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max characters of LLM response text included in error `details`. */
const SNIPPET_MAX = 500;

/** Kiro CLI binary name. Override via `KIRO_CLI_BIN` env when the binary
 *  is not on PATH (e.g. dev containers). */
const DEFAULT_KIRO_CLI_BIN = "kiro-cli";

/** Default Kiro model. Override via `KIRO_MODEL` env. Sonnet 4.6 is the
 *  cheap-enough default — the Opus 4.7 option costs 2.20x credits. */
const DEFAULT_KIRO_MODEL = "claude-sonnet-4.6";

/** Max output tokens when the caller does not pass one. Not currently
 *  honoured by kiro-cli (it has no --max-tokens flag), but we keep the
 *  option in the `CallLLMOptions` shape for callers that already pass it. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Role = "system" | "user" | "assistant";

export interface LLMMessage {
  role: Role | string;
  content: string;
}

export interface CallLLMOptions {
  timeoutMs: number;
  maxOutputTokens?: number;
  /** When `"json_object"`, we append an instruction telling Kiro to reply
   *  with ONLY the JSON object — no prose, no markdown fences. */
  responseFormat?: "json_object" | "text";
}

// ---------------------------------------------------------------------------
// Defensive parsing helpers
// ---------------------------------------------------------------------------

/** Truncate to `SNIPPET_MAX` chars, appending `…` when truncation happens. */
function snippet(s: string): string {
  if (s.length <= SNIPPET_MAX) return s;
  return s.slice(0, SNIPPET_MAX - 1) + "…";
}

/**
 * Strip common Markdown fences that LLMs stubbornly wrap JSON in even when
 * told not to. Matches an optional leading "```[lang]\n" and a trailing "```".
 */
function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  // Drop the opening fence (optionally with a language tag like ```json).
  let body = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "");
  // Drop the closing fence if present at the very end.
  if (body.endsWith("```")) {
    body = body.slice(0, -3);
  }
  return body.trim();
}

/** Parse JSON after stripping code fences; throws on syntax error. */
function parseJsonLoose(s: string): unknown {
  return JSON.parse(stripCodeFences(s));
}

// ---------------------------------------------------------------------------
// callLLM — the single I/O primitive shared by all four tasks
// ---------------------------------------------------------------------------

/**
 * Make a single LLM request. Throws `LLM_TIMEOUT` when the abort signal
 * fires and `LLM_OUTPUT_INVALID` for non-2xx or network failures. When a
 * logger is supplied the call is wrapped in `logger.timed("llm_call", …)`
 * so `durationMs` lands in the stage log.
 *
 * _Requirements: 4.1, 5.1, 6.1, 7.7, 14.6, 14.9_
 */
export async function callLLM(
  messages: LLMMessage[],
  opts: CallLLMOptions,
  logger?: WorkbenchLogger,
): Promise<string> {
  const run = () => invokeKiroCli(messages, opts);
  if (!logger) return run();

  return logger.timed("llm_call", run, {
    provider: "kiro-cli",
    model: process.env.KIRO_MODEL ?? DEFAULT_KIRO_MODEL,
    timeoutMs: opts.timeoutMs,
    responseFormat: opts.responseFormat ?? "text",
  });
}

// ---------------------------------------------------------------------------
// Kiro CLI integration
// ---------------------------------------------------------------------------

/**
 * Flatten LLMMessage[] into a single prompt string that we feed to
 * `kiro-cli chat` via stdin.
 *
 * Kiro CLI's `chat` subcommand only takes a single INPUT string, so we
 * emulate the standard system / user / assistant role convention by
 * prefixing each block with its role label. Claude understands role
 * prefixes perfectly well, and the resulting prompt is still short
 * enough to fit in the 1M context window.
 *
 * If `responseFormat === "json_object"` we append an explicit instruction
 * so Kiro replies with ONLY the JSON object — no prose, no code fences.
 * The `parseJsonLoose` helper still strips stray fences as a safety net.
 */
function flattenMessages(
  messages: LLMMessage[],
  responseFormat: "json_object" | "text" | undefined,
): string {
  const parts: string[] = [];
  for (const m of messages) {
    const label =
      m.role === "system"
        ? "SYSTEM"
        : m.role === "assistant"
          ? "ASSISTANT"
          : "USER";
    parts.push(`[${label}]\n${m.content}`);
  }
  if (responseFormat === "json_object") {
    parts.push(
      "[USER]\nRespond ONLY with a single valid JSON object. No prose, no markdown fences, no commentary.",
    );
  }
  return parts.join("\n\n");
}

/**
 * Strip ANSI escape sequences (SGR colours, cursor show/hide, misc
 * control codes) from `s`. `kiro-cli` writes colour-coded banners
 * regardless of NO_COLOR / TERM — we peel them off server-side.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[?0-9;]*[a-zA-Z]/g, "");
}

/**
 * Extract the model's reply from a raw `kiro-cli chat --no-interactive`
 * invocation. Layout (empirically observed on v2.2.2):
 *
 *   <trust warnings>       <- "All tools are now trusted…" through
 *                             "…tools-trust-all-safely"
 *   <blank lines>
 *   > <MODEL REPLY>        <- one or more lines, starts with "> "
 *   <blank line>
 *    ▸ Credits: 0.37 • Time: 1s   <- footer — always begins with " ▸"
 *   <terminal reset codes>
 *
 * The reply body sits strictly between the first `> ` prompt marker and
 * the `▸ Credits:` footer. We take everything in that window, trim the
 * leading "> " off the first line, and return it.
 *
 * Falls back to a best-effort full-text trim when the markers are absent
 * — but kiro-cli always emits them on success, so the happy path hits the
 * structured branch.
 */
function extractKiroReply(raw: string): string {
  const clean = stripAnsi(raw);
  const creditsIdx = clean.search(/\n[ ]*▸\s*(?:\*{0,2}\s*)?Credits:/);
  const tail = creditsIdx >= 0 ? clean.slice(0, creditsIdx) : clean;

  const marker = tail.indexOf("\n> ");
  if (marker >= 0) {
    // +3 to skip past "\n> "
    return tail.slice(marker + 3).trim();
  }
  // Fallback: check if the output *starts* with "> " (no leading newline)
  if (tail.startsWith("> ")) {
    return tail.slice(2).trim();
  }
  return tail.trim();
}

interface KiroCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn `kiro-cli chat`, pipe the prompt into stdin, collect stdout
 * until the process exits or the abort signal fires. Kiro's exit codes:
 *   - 0 on success
 *   - non-zero on crash / auth failure
 *
 * Resolves with `{ exitCode, stdout, stderr, timedOut }`; never throws —
 * the caller decides how to classify the result.
 */
function spawnKiroCli(
  prompt: string,
  opts: CallLLMOptions,
): Promise<KiroCliResult> {
  return new Promise((resolve) => {
    const bin = process.env.KIRO_CLI_BIN ?? DEFAULT_KIRO_CLI_BIN;
    const model = process.env.KIRO_MODEL ?? DEFAULT_KIRO_MODEL;
    const args = [
      "chat",
      "--no-interactive",
      "--trust-all-tools",
      "--model",
      model,
    ];

    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first; if the process hangs, the OS will eventually reap it
      // via SIGKILL on process exit. Resolving from the `exit` handler
      // below is fine; no double-resolve possible because of `settled`.
      try {
        child.kill("SIGTERM");
      } catch {
        /* swallow — the "exit" handler still fires */
      }
    }, opts.timeoutMs);

    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: String(err?.message ?? err),
        timedOut,
      });
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: typeof code === "number" ? code : -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
      });
    });

    // Write the prompt and close stdin so kiro-cli's reader sees EOF.
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: `stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
          timedOut,
        });
      }
    }
  });
}

async function invokeKiroCli(
  messages: LLMMessage[],
  opts: CallLLMOptions,
): Promise<string> {
  const prompt = flattenMessages(messages, opts.responseFormat);
  const result = await spawnKiroCli(prompt, opts);

  if (result.timedOut) {
    throw new WorkbenchError(
      ErrorCode.LLM_TIMEOUT,
      `LLM request exceeded ${opts.timeoutMs}ms`,
      { timeoutMs: opts.timeoutMs },
    );
  }

  if (result.exitCode !== 0) {
    throw new WorkbenchError(
      ErrorCode.LLM_OUTPUT_INVALID,
      `kiro-cli exit ${result.exitCode}: ${snippet(result.stderr || result.stdout)}`,
      { exitCode: result.exitCode, cause: "kiro-cli" },
    );
  }

  const reply = extractKiroReply(result.stdout);
  if (reply.length === 0) {
    throw new WorkbenchError(
      ErrorCode.LLM_OUTPUT_INVALID,
      "kiro-cli returned empty reply",
      { snippet: snippet(result.stdout) },
    );
  }
  return reply;
}

// Touch `DEFAULT_MAX_OUTPUT_TOKENS` so the constant is not reported as
// unused by the linter (kept for API compatibility with older callers
// that may rely on `opts.maxOutputTokens`).
void DEFAULT_MAX_OUTPUT_TOKENS;

// ---------------------------------------------------------------------------
// Brief generation
// ---------------------------------------------------------------------------

/**
 * Build the `topic → Brief` messages. The system message pins the JSON
 * schema; the user message supplies topic + locale so natural-language
 * fields are written in the Project's locale.
 *
 * `attempt` ≥ 2 injects the previous failure context so the model can
 * self-correct.
 */
function buildBriefMessages(
  project: Project,
  attempt: number,
  lastIssue: string | null,
): LLMMessage[] {
  const locale = project.locale ?? DEFAULT_LOCALE;
  const system = [
    "You are a video script writer.",
    "Respond ONLY with a single JSON object matching this schema — no prose, no markdown fences:",
    `{`,
    `  "title": "string, 1-${LIMITS.BRIEF_TITLE_MAX} chars",`,
    `  "audience": "string, 1-${LIMITS.BRIEF_AUDIENCE_MAX} chars",`,
    `  "corePoints": ["array of ${LIMITS.BRIEF_CORE_POINTS_MIN}-${LIMITS.BRIEF_CORE_POINTS_MAX} strings, each 1-${LIMITS.BRIEF_CORE_POINT_MAX} chars"],`,
    `  "tone": "string, 1-${LIMITS.BRIEF_TONE_MAX} chars",`,
    `  "targetDurationSec": "integer, ${LIMITS.BRIEF_TARGET_DURATION_MIN}-${LIMITS.BRIEF_TARGET_DURATION_MAX}",`,
    `  "suggestedStyle": "string, 1-${LIMITS.BRIEF_STYLE_MAX} chars"`,
    `}`,
    `Write all natural-language fields in locale "${locale}".`,
    "Do not include control characters.",
  ].join("\n");

  const user = `Topic: ${project.topic}`;

  const msgs: LLMMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  if (attempt > 1 && lastIssue) {
    msgs.push({
      role: "user",
      content: `Previous attempt failed validation: ${snippet(
        lastIssue,
      )}. Return a corrected JSON object that satisfies every constraint.`,
    });
  }

  return msgs;
}

/**
 * Generate a Brief from `project.topic`. Up to `LLM_BRIEF_MAX_ATTEMPTS`
 * total attempts, each bounded by `TIMEOUTS_MS.LLM_BRIEF`.
 *
 * _Requirements: 4.1, 4.2, 4.3, 4.4, 4.7_
 */
export async function generateBrief(project: Project): Promise<Brief> {
  const logger = createLogger(project.projectId, "brief");

  let lastSnippetStr = "";
  let lastIssue: string | null = null;
  let lastIssues: unknown[] | undefined;

  for (let attempt = 1; attempt <= LLM_BRIEF_MAX_ATTEMPTS; attempt++) {
    await logger.info("brief_attempt", { attempt });

    const messages = buildBriefMessages(project, attempt, lastIssue);

    let raw: string;
    try {
      raw = await callLLM(
        messages,
        {
          timeoutMs: TIMEOUTS_MS.LLM_BRIEF,
          responseFormat: "json_object",
        },
        logger,
      );
    } catch (err) {
      // Timeouts and network/HTTP failures are terminal for that attempt —
      // but we still retry until the budget is exhausted. After the final
      // attempt, re-throw so the caller sees the original error.
      if (attempt === LLM_BRIEF_MAX_ATTEMPTS) throw err;
      lastIssue = err instanceof Error ? err.message : String(err);
      continue;
    }

    lastSnippetStr = snippet(raw);

    let parsed: unknown;
    try {
      parsed = parseJsonLoose(raw);
    } catch (err) {
      lastIssue = `JSON parse failed: ${(err as Error).message}`;
      await logger.warn("brief_parse_error", {
        attempt,
        reason: "json_syntax",
      });
      continue;
    }

    const result = BriefSchema.safeParse(parsed);
    if (result.success) {
      await logger.info("brief_success", { attempt });
      return result.data;
    }

    lastIssues = result.error.issues;
    lastIssue = JSON.stringify(result.error.issues).slice(0, SNIPPET_MAX);
    await logger.warn("brief_parse_error", {
      attempt,
      reason: "schema",
      issues: result.error.issues,
    });
  }

  throw new WorkbenchError(
    ErrorCode.LLM_OUTPUT_INVALID,
    `Could not produce a valid Brief after ${LLM_BRIEF_MAX_ATTEMPTS} attempts`,
    {
      snippet: lastSnippetStr,
      issues: lastIssues,
    },
  );
}

// ---------------------------------------------------------------------------
// Storyboard generation
// ---------------------------------------------------------------------------

interface StoryboardWarning {
  actualTotalSec: number;
  targetDurationSec: number;
  toleranceRange: [number, number];
  deviationPercent: number;
}

function totalDurationSec(scenes: StoryboardOutput["scenes"]): number {
  let total = 0;
  for (const s of scenes) total += s.durationSec;
  return total;
}

function buildStoryboardMessages(
  project: Project,
  brief: Brief,
  toleranceRetry: boolean,
  schemaRetryIssue: string | null,
): LLMMessage[] {
  const locale = project.locale ?? DEFAULT_LOCALE;
  const target = brief.targetDurationSec;
  const lo = Math.round(target * (1 - LIMITS.STORYBOARD_TOLERANCE_PCT));
  const hi = Math.round(target * (1 + LIMITS.STORYBOARD_TOLERANCE_PCT));

  const system = [
    "You are a video storyboard writer.",
    "Respond ONLY with a single JSON object — no prose, no markdown fences — matching this schema:",
    `{`,
    `  "scenes": [`,
    `    {`,
    `      "title": "string, 1-${LIMITS.SCENE_TITLE_MAX} chars",`,
    `      "narration": "string, 1-${LIMITS.SCENE_NARRATION_MAX} chars",`,
    `      "durationSec": "integer, ${LIMITS.SCENE_DURATION_MIN_STORYBOARD}-${LIMITS.SCENE_DURATION_MAX_STORYBOARD}",`,
    `      "voice": "one of: alloy, echo, fable, onyx, nova, shimmer"`,
    `    }`,
    `  ]`,
    `}`,
    `scenes MUST contain ${LIMITS.STORYBOARD_MIN_SCENES}-${LIMITS.STORYBOARD_MAX_SCENES} entries, ordered as they should play.`,
    `The sum of every durationSec MUST land between ${lo} and ${hi} seconds (target ${target}s).`,
    `Write every narration/title in locale "${locale}".`,
    "Do not include control characters.",
  ].join("\n");

  const briefJson = JSON.stringify(brief, null, 2);
  const user = [
    `Brief:`,
    briefJson,
    ``,
    `Produce a storyboard that best covers the corePoints using the tone and suggestedStyle.`,
  ].join("\n");

  const msgs: LLMMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  if (toleranceRetry) {
    msgs.push({
      role: "user",
      content: `Previous attempt's total duration was outside [${lo}, ${hi}] seconds. Adjust the durationSec values so the sum lands strictly inside that range while keeping the same narrative.`,
    });
  } else if (schemaRetryIssue) {
    msgs.push({
      role: "user",
      content: `Previous attempt failed schema validation: ${snippet(
        schemaRetryIssue,
      )}. Return a corrected JSON object that satisfies every constraint exactly.`,
    });
  }

  return msgs;
}

/**
 * Generate storyboard scenes from `project.brief`. Returns the raw scenes
 * array (sceneId/index are assigned by the caller) plus an optional
 * `warning` when the total duration falls outside the ±15% tolerance band
 * after the retry budget is spent.
 *
 * _Requirements: 5.1, 5.3, 5.4, 5.5, 5.6_
 */
export async function generateStoryboardFromBrief(project: Project): Promise<{
  scenes: StoryboardOutput["scenes"];
  warning?: StoryboardWarning;
}> {
  if (!project.brief) {
    throw new WorkbenchError(
      ErrorCode.INVALID_STAGE,
      "Brief not present — cannot generate storyboard",
    );
  }
  const brief = project.brief;
  const logger = createLogger(project.projectId, "storyboard");

  const target = brief.targetDurationSec;
  const toleranceLo = target * (1 - LIMITS.STORYBOARD_TOLERANCE_PCT);
  const toleranceHi = target * (1 + LIMITS.STORYBOARD_TOLERANCE_PCT);

  let lastValidScenes: StoryboardOutput["scenes"] | null = null;
  let lastTotal = 0;
  let lastSnippetStr = "";
  let lastIssue: string | null = null;
  let needToleranceRetry = false;

  for (let attempt = 1; attempt <= LLM_STORYBOARD_MAX_ATTEMPTS; attempt++) {
    await logger.info("storyboard_attempt", {
      attempt,
      retryReason: needToleranceRetry
        ? "tolerance"
        : lastIssue
          ? "schema"
          : null,
    });

    const messages = buildStoryboardMessages(
      project,
      brief,
      needToleranceRetry,
      needToleranceRetry ? null : lastIssue,
    );

    let raw: string;
    try {
      raw = await callLLM(
        messages,
        {
          timeoutMs: TIMEOUTS_MS.LLM_STORYBOARD,
          responseFormat: "json_object",
        },
        logger,
      );
    } catch (err) {
      if (attempt === LLM_STORYBOARD_MAX_ATTEMPTS) throw err;
      lastIssue = err instanceof Error ? err.message : String(err);
      needToleranceRetry = false;
      continue;
    }

    lastSnippetStr = snippet(raw);

    let parsed: unknown;
    try {
      parsed = parseJsonLoose(raw);
    } catch (err) {
      lastIssue = `JSON parse failed: ${(err as Error).message}`;
      needToleranceRetry = false;
      await logger.warn("storyboard_parse_error", {
        attempt,
        reason: "json_syntax",
      });
      continue;
    }

    const result = StoryboardOutputSchema.safeParse(parsed);
    if (!result.success) {
      lastIssue = JSON.stringify(result.error.issues).slice(0, SNIPPET_MAX);
      needToleranceRetry = false;
      await logger.warn("storyboard_parse_error", {
        attempt,
        reason: "schema",
        issues: result.error.issues,
      });
      continue;
    }

    // Schema OK — check tolerance.
    const scenes = result.data.scenes;
    const total = totalDurationSec(scenes);
    lastValidScenes = scenes;
    lastTotal = total;

    if (total >= toleranceLo && total <= toleranceHi) {
      await logger.info("storyboard_success", {
        attempt,
        totalSec: total,
        targetSec: target,
      });
      return { scenes };
    }

    // Tolerance fail — retry once if budget allows.
    if (attempt < LLM_STORYBOARD_MAX_ATTEMPTS) {
      needToleranceRetry = true;
      lastIssue = null;
      await logger.warn("storyboard_tolerance_fail", {
        attempt,
        totalSec: total,
        targetSec: target,
      });
      continue;
    }

    // Out of retries with a tolerance miss — return with warning.
    const deviationPercent =
      target > 0 ? (Math.abs(total - target) / target) * 100 : 0;
    await logger.warn("storyboard_success_with_warning", {
      attempt,
      totalSec: total,
      targetSec: target,
      deviationPercent,
    });
    return {
      scenes,
      warning: {
        actualTotalSec: total,
        targetDurationSec: target,
        toleranceRange: [toleranceLo, toleranceHi],
        deviationPercent,
      },
    };
  }

  // Loop exited without returning — only reachable when every attempt
  // failed schema/parse/network. If we ever produced valid scenes we would
  // have returned above. Surface the last failure with the snippet.
  if (lastValidScenes) {
    // Defensive — this branch should be unreachable given the control flow
    // above, but keep the warning path honest just in case.
    const deviationPercent =
      target > 0 ? (Math.abs(lastTotal - target) / target) * 100 : 0;
    return {
      scenes: lastValidScenes,
      warning: {
        actualTotalSec: lastTotal,
        targetDurationSec: target,
        toleranceRange: [toleranceLo, toleranceHi],
        deviationPercent,
      },
    };
  }

  throw new WorkbenchError(
    ErrorCode.LLM_OUTPUT_INVALID,
    `Could not produce a valid Storyboard after ${LLM_STORYBOARD_MAX_ATTEMPTS} attempts`,
    {
      snippet: lastSnippetStr,
      lastIssue,
    },
  );
}

// ---------------------------------------------------------------------------
// Composition HTML generation
// ---------------------------------------------------------------------------

function buildCompositionMessages(
  project: Project,
  lintError: string | undefined,
): LLMMessage[] {
  const storyboard = project.storyboard;
  // Caller guarantees storyboard is set — the helper below enforces it.
  const scenesJson = JSON.stringify(storyboard?.scenes ?? [], null, 2);
  const locale = project.locale ?? DEFAULT_LOCALE;

  const system = [
    "You generate a single self-contained HyperFrames-compatible HTML document.",
    "Return ONLY the HTML — no prose, no markdown fences, no explanation.",
    "",
    "Hard rules (output will be rejected if any rule is violated):",
    "  1. Every timed element MUST have data-start, data-duration, and data-track-index attributes (seconds, floats allowed).",
    "  2. Every visible timed element MUST include class=\"clip\".",
    "  3. GSAP timelines MUST be constructed with { paused: true } and pushed to window.__timelines (an array you create if absent).",
    "  4. No Date.now(), no Math.random(), no fetch(), no XMLHttpRequest, no <iframe>, <object>, or <embed>.",
    "  5. The root timeline duration MUST equal the sum of every scene's durationSec (tolerance ±0.5s).",
    "  6. Scenes play sequentially on track 0; each scene's data-start equals the cumulative duration of previous scenes.",
    `  7. Natural-language copy rendered to the viewer MUST be in locale "${locale}".`,
    "  8. The document must be valid standalone HTML (<!doctype html>… <html>… </html>).",
  ].join("\n");

  const user = [
    "Generate the composition HTML for this storyboard:",
    scenesJson,
  ].join("\n");

  const msgs: LLMMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  if (lintError) {
    msgs.push({
      role: "user",
      content: `Previous output failed lint with: ${snippet(
        lintError,
      )}. Fix the issues and regenerate the complete HTML document from scratch.`,
    });
  }

  return msgs;
}

/**
 * Generate a single pass of HyperFrames HTML from the project's storyboard.
 * The caller (route handler) runs `scanHtml` / `hyperframes lint` /
 * `hyperframes validate` on the output and may call this function again
 * with `lintError` populated for a single repair retry.
 *
 * _Requirements: 6.1, 6.3, 6.4, 6.6_
 */
export async function generateCompositionHtml(
  project: Project,
  lintError?: string,
): Promise<string> {
  if (!project.storyboard || project.storyboard.scenes.length === 0) {
    throw new WorkbenchError(
      ErrorCode.INVALID_STAGE,
      "Storyboard not present — cannot generate composition",
    );
  }
  const logger = createLogger(project.projectId, "composition");

  await logger.info("composition_attempt", { repair: Boolean(lintError) });

  const messages = buildCompositionMessages(project, lintError);

  const raw = await callLLM(
    messages,
    {
      timeoutMs: TIMEOUTS_MS.LLM_COMPOSITION,
      responseFormat: "text",
      // Composition output is the largest of the four tasks — raise the
      // token cap so long scenes don't get truncated mid-document.
      maxOutputTokens: 8192,
    },
    logger,
  );

  // Some models still wrap the document in ```html fences despite the
  // system prompt — strip them but otherwise return as-is so the caller
  // can run downstream validators against the unaltered text.
  const html = stripCodeFences(raw);

  await logger.info("composition_success", { bytes: html.length });
  return html;
}

// ---------------------------------------------------------------------------
// Scene rewrite
// ---------------------------------------------------------------------------

function findNeighborNarrations(
  project: Project,
  scene: Scene,
): { prev: string; next: string } {
  const scenes = project.storyboard?.scenes ?? [];
  const idx = scenes.findIndex((s) => s.sceneId === scene.sceneId);
  const prev = idx > 0 ? scenes[idx - 1].narration : "";
  const next = idx >= 0 && idx < scenes.length - 1 ? scenes[idx + 1].narration : "";
  return { prev, next };
}

function buildRewriteMessages(
  project: Project,
  scene: Scene,
  qaNote: string,
): LLMMessage[] {
  const locale = project.locale ?? DEFAULT_LOCALE;
  const { prev, next } = findNeighborNarrations(project, scene);

  const system = [
    "You are a video scene-rewrite assistant.",
    "Respond ONLY with a single JSON object — no prose, no markdown fences — matching this schema:",
    `{`,
    `  "narration": "string, ${LIMITS.SCENE_NARRATION_MIN_REWRITE}-${LIMITS.SCENE_NARRATION_MAX_POST_REWRITE} chars",`,
    `  "durationSec": "integer, ${LIMITS.SCENE_DURATION_MIN_REWRITE}-${LIMITS.SCENE_DURATION_MAX_REWRITE} (optional — omit if unchanged)"`,
    `}`,
    `Write narration in locale "${locale}". Do not include control characters.`,
    "Only rewrite the target scene. Keep continuity with the neighbor scenes but do NOT regenerate them.",
  ].join("\n");

  const user = [
    `Previous scene narration: ${prev}`,
    `--`,
    `Target scene:`,
    `  title: ${scene.title}`,
    `  current narration: ${scene.narration}`,
    `  current durationSec: ${scene.durationSec}`,
    `  QA note: ${qaNote}`,
    `--`,
    `Next scene narration: ${next}`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Rewrite a single Scene's narration (and optionally durationSec) given a
 * QA note. No retry on failure per Req 7.7 — the caller returns HTTP 502
 * and the user decides whether to try again.
 *
 * _Requirements: 7.1, 7.2, 7.7_
 */
export async function rewriteScene(
  project: Project,
  scene: Scene,
  qaNote: string,
): Promise<{ narration: string; durationSec?: number }> {
  const logger = createLogger(project.projectId, "qa");

  await logger.info("rewrite_attempt", { sceneId: scene.sceneId });

  const messages = buildRewriteMessages(project, scene, qaNote);

  const raw = await callLLM(
    messages,
    {
      timeoutMs: TIMEOUTS_MS.LLM_REWRITE,
      responseFormat: "json_object",
    },
    logger,
  );

  const rawSnippet = snippet(raw);

  let parsed: unknown;
  try {
    parsed = parseJsonLoose(raw);
  } catch (err) {
    throw new WorkbenchError(
      ErrorCode.LLM_OUTPUT_INVALID,
      `Rewrite response was not valid JSON: ${(err as Error).message}`,
      { snippet: rawSnippet },
    );
  }

  const result = SceneRewriteOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkbenchError(
      ErrorCode.LLM_OUTPUT_INVALID,
      "Rewrite response failed schema validation",
      {
        snippet: rawSnippet,
        issues: result.error.issues,
      },
    );
  }

  await logger.info("rewrite_success", { sceneId: scene.sceneId });

  const out: { narration: string; durationSec?: number } = {
    narration: result.data.narration,
  };
  if (typeof result.data.durationSec === "number") {
    out.durationSec = result.data.durationSec;
  }
  return out;
}
