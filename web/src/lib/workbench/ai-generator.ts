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
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_LOCALE,
  LIMITS,
  LLM_BRIEF_MAX_ATTEMPTS,
  LLM_STORYBOARD_MAX_ATTEMPTS,
  TIMEOUTS_MS,
  VOICES,
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
 *
 * Also handles the kiro-cli TUI edge case: when kiro-cli renders a
 * `\`\`\`html` fence in its output, the backticks are consumed by the
 * markdown renderer but the language tag (`html`) leaks through on a line
 * of its own. We treat a solo `html` / `json` / `javascript` / `typescript`
 * prefix line as a language tag residue and strip it.
 */
function stripCodeFences(s: string): string {
  let trimmed = s.trim();

  // Standard fence stripping.
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "");
    if (trimmed.endsWith("```")) {
      trimmed = trimmed.slice(0, -3);
    }
    return trimmed.trim();
  }

  // kiro-cli TUI residue: the opening backticks were eaten by the markdown
  // renderer, leaving only the language tag as the first line. Drop it.
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline > 0) {
    const firstLine = trimmed.slice(0, firstNewline).trim();
    if (/^(html|json|javascript|typescript|ts|js|css|xml)$/i.test(firstLine)) {
      return trimmed.slice(firstNewline + 1).trim();
    }
  }

  return trimmed;
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
    `      "voice": "one of: ${VOICES.join(", ")}"`,
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

/**
 * Cached reference template loaded from the HyperFrames source directory.
 * Used as a few-shot example in the composition prompt so the LLM sees the
 * exact shape of a valid `__timelines` registration, `.scene.clip` element,
 * GSAP timeline body, and `<style>` block rather than trying to synthesise
 * one from abstract rules.
 *
 * Resolution precedence (matches template-manager.ts):
 *   1. `process.env.HYPERFRAMES_TEMPLATE_DIR`/index.html
 *   2. `<cwd>/../{hf-blank, linear-launch}/index.html`
 *   3. `<cwd>/../../{hf-blank, linear-launch}/index.html`
 *
 * `hf-blank` is the canonical HyperFrames baseline (from
 * `npx hyperframes init --example blank`) — minimal structure, zero visual
 * bias. `linear-launch` is a legacy fallback kept for backward compat.
 *
 * Any resolution failure falls back to `null`, in which case the prompt
 * reverts to the abstract-rules-only format. The cache is keyed by the
 * resolved absolute path so changing `HYPERFRAMES_TEMPLATE_DIR` at runtime
 * is observed (path-based invalidation, no TTL).
 */
let referenceTemplateCache: {
  path: string;
  html: string;
} | null = null;

const REFERENCE_TEMPLATE_DIR_NAMES: readonly string[] = [
  "hf-blank",
  "linear-launch",
];

async function loadReferenceTemplate(): Promise<string | null> {
  const envDir = process.env.HYPERFRAMES_TEMPLATE_DIR;
  const cwd = process.cwd();
  const candidates: string[] = [];
  if (envDir) candidates.push(path.resolve(cwd, envDir, "index.html"));
  for (const name of REFERENCE_TEMPLATE_DIR_NAMES) {
    candidates.push(path.resolve(cwd, "..", name, "index.html"));
  }
  for (const name of REFERENCE_TEMPLATE_DIR_NAMES) {
    candidates.push(path.resolve(cwd, "..", "..", name, "index.html"));
  }

  for (const abs of candidates) {
    if (referenceTemplateCache?.path === abs) {
      return referenceTemplateCache.html;
    }
    try {
      const html = await readFile(abs, "utf8");
      referenceTemplateCache = { path: abs, html };
      return html;
    } catch {
      // try next candidate
    }
  }
  // Invalidate stale cache entry whose file no longer exists.
  referenceTemplateCache = null;
  return null;
}

// ---------------------------------------------------------------------------
// Per-scene sub-composition generation (Plan A: scene sharding)
// ---------------------------------------------------------------------------
//
// Architecture: instead of one massive LLM call that produces the whole
// composition HTML (300+ lines, 11 scenes, all inline CSS + all timelines),
// we make N small calls — one per scene — each producing a sub-composition
// HTML file ~1-3 KB. The main `index.html` is then assembled by
// deterministic code (`assembleIndexHtml`) that stitches scene references
// with `data-composition-src`.
//
// Each scene sub-composition follows the HyperFrames external-composition
// contract (see docs/concepts/compositions):
//   <template id="scene-NN-template">
//     <div data-composition-id="scene-NN" data-width="1920" data-height="1080">
//       <style>[data-composition-id="scene-NN"] { ... }</style>
//       ...content...
//       <script>
//         const tl = gsap.timeline({ paused: true });
//         // tl.from(...) etc.
//         window.__timelines["scene-NN"] = tl;
//       </script>
//     </div>
//   </template>
//
// Benefits over the monolithic approach:
//   - Per-call output is small → no truncation, no timeout on complex scenes
//   - Single scene failure can be retried independently
//   - Users can regenerate one scene without rebuilding the whole video
//   - LLM focuses on one visual concept at a time (higher quality per scene)

function buildSceneMessages(
  project: Project,
  scene: Scene,
  context: { prevNarration?: string; nextNarration?: string },
  referenceTemplate: string | null,
  lintError: string | undefined,
): LLMMessage[] {
  const locale = project.locale ?? DEFAULT_LOCALE;
  const compositionId = sceneCompositionId(scene);

  const system = [
    "You generate ONE HyperFrames sub-composition HTML file for a single scene.",
    "Your output is a `.html` file that will be loaded via `data-composition-src` from a parent composition. It is NOT a full HTML document.",
    "",
    "===== OUTPUT FORMAT =====",
    "Wrap your ENTIRE output inside a single ```html code fence:",
    "  ```html",
    "  <template id=\"" + compositionId + "-template\">",
    "    ... content ...",
    "  </template>",
    "  ```",
    "The code fence prevents terminal rendering from corrupting asterisks and other markdown-sensitive characters. Output NOTHING outside the fence.",
    "",
    "===== REQUIRED STRUCTURE =====",
    "The file MUST be exactly this shape:",
    "  <template id=\"" + compositionId + "-template\">",
    `    <div id="${compositionId}" data-composition-id="${compositionId}" data-width="1920" data-height="1080">`,
    "      <!-- your content here: text, SVG, divs — whatever the scene needs -->",
    "      <style>",
    `        #${compositionId} { /* scoped CSS — use #${compositionId} NOT [data-composition-id="..."] */ }`,
    `        #${compositionId} .some-child { /* every rule must start with #${compositionId} */ }`,
    "      </style>",
    "      <script>",
    "        window.__timelines = window.__timelines || {};",
    "        const tl = gsap.timeline({ paused: true });",
    `        // GSAP selectors MUST be fully-qualified with the #${compositionId} prefix,`,
    `        // e.g. tl.from('#${compositionId} .title', {...}).`,
    `        // DO NOT call document.querySelector('#${compositionId}') — when the <script>`,
    "        // runs, the <template> content is not yet in the live document tree and that",
    "        // lookup returns null. The framework ensures the DOM is live by the time",
    "        // the timeline plays, so fully-qualified selectors resolve correctly then.",
    `        tl.from('#${compositionId} .some-child', { opacity: 0, duration: 1 }, 0);`,
    `        window.__timelines["${compositionId}"] = tl;`,
    "      </script>",
    "    </div>",
    "  </template>",
    "",
    "===== HARD RULES (lint-rejected if violated) =====",
    `  1. Root <template id="${compositionId}-template"> with inner <div id="${compositionId}" data-composition-id="${compositionId}">.`,
    `  2. CSS selectors inside <style> MUST use the id prefix \`#${compositionId}\` — NEVER \`[data-composition-id="..."]\`. The attribute-selector form leaks into sibling instances when the same sub-composition is embedded twice; id-selector form stays instance-isolated.`,
    `  3. GSAP selectors inside <script> MUST also be fully-qualified with \`#${compositionId} \` prefix (e.g. \`'#${compositionId} .title'\`). Do NOT call \`document.querySelector\` or \`getElementById\` at script load time — the template content is not yet in the live DOM.`,
    `  4. The <script> MUST register the timeline via window.__timelines["${compositionId}"] = tl;`,
    "  5. GSAP timeline must use { paused: true }.",
    "  6. NO repeat: -1 or other infinite animations — HyperFrames renders deterministic frames, infinite tweens break the capture engine. Use a finite `repeat` count derived from the scene duration (e.g. `repeat: Math.floor(totalDuration / cycleDuration) - 1`).",
    "  7. NO Math.random(), NO Date.now(), NO fetch(), NO XMLHttpRequest, NO <iframe>, NO <object>, NO <embed>.",
    "  8. All on-screen text MUST be in locale " + locale + ".",
    "  9. DO NOT include <!doctype html>, <html>, <head>, or <body> tags — those belong to the parent composition.",
    `  10. DO NOT include data-start, data-duration, or data-track-index attributes on your root — those are set by the parent composition.`,
    "",
    "===== VISUAL DIRECTION =====",
    "This scene has " + scene.durationSec + " seconds of screen time. Design for that pace.",
    "",
    "QUALITY BAR: Aim for a polished, broadcast-quality animation. Think 3Blue1Brown / Kurzgesagt visual style:",
    "  - Rich dark backgrounds (deep navy, near-black) with subtle radial gradients",
    "  - Glowing accent colors (electric blue, amber, coral) with CSS filter: drop-shadow or box-shadow",
    "  - Inline SVG for mathematical/scientific concepts — unit circles, wave curves, coordinate axes, geometric shapes",
    "  - Multi-layer composition: background grid/texture + main visual element + text overlay",
    "  - Typography: large bold Chinese title (80-120px), smaller subtitle (28-40px), caption at bottom",
    "  - GSAP timeline should use the full scene duration — don't leave the last 30% empty",
    "",
    "Use the right visual weight for the scene's narrative role:",
    "  - Concept/educational: inline SVG for visual metaphors (circles, waves, diagrams).",
    "  - Text-heavy: typography + CSS gradients + GSAP reveals.",
    "  - Data/comparison: SVG charts, animated paths, GSAP tween on values.",
    "",
    "Scene complexity guide (aim for the upper end):",
    "  - Background layer: radial-gradient + optional perspective grid (CSS transform: perspective + rotateX)",
    "  - Main visual: SVG with 5-15 elements (axes, circles, paths, labels, dots)",
    "  - Text layer: title block (eyebrow + main title + subtitle) + bottom caption",
    "  - Animation: 8-15 GSAP tweens spread across the full duration, staggered reveals",
    "  - Total HTML: 6-12 KB is fine — quality matters more than file size",
    "",
    "Animation tips:",
    "  - Use power3.out / power2.out for natural motion.",
    "  - Stagger reveals within a scene to guide attention.",
    "  - Animate SVG stroke-dashoffset for drawing effects (circles, paths appearing).",
    "  - Use GSAP rotation on SVG groups for spinning/orbiting elements.",
    "  - Fade out at the very end (duration - 0.7s) if your content doesn't need to linger.",
  ].join("\n");

  const messages: LLMMessage[] = [{ role: "system", content: system }];

  if (referenceTemplate) {
    messages.push({
      role: "user",
      content: [
        "For reference, here is the OFFICIAL HyperFrames minimal parent composition template (index.html). You are NOT generating this — you are generating a sub-composition that will be mounted inside it.",
        "",
        "```html",
        referenceTemplate,
        "```",
      ].join("\n"),
    });
  }

  const contextBlock = [
    "Scene data:",
    "```json",
    JSON.stringify(
      {
        compositionId,
        title: scene.title,
        narration: scene.narration,
        durationSec: scene.durationSec,
        index: scene.index,
      },
      null,
      2,
    ),
    "```",
  ];

  if (context.prevNarration || context.nextNarration) {
    contextBlock.push("", "Narrative context (for visual continuity, do not render these):");
    if (context.prevNarration) {
      contextBlock.push(`  - Previous scene: ${snippet(context.prevNarration)}`);
    }
    if (context.nextNarration) {
      contextBlock.push(`  - Next scene: ${snippet(context.nextNarration)}`);
    }
  }

  contextBlock.push(
    "",
    "Project topic: " + snippet(project.topic),
  );
  if (project.brief?.suggestedStyle) {
    contextBlock.push("Visual style hint: " + snippet(project.brief.suggestedStyle));
  }

  messages.push({
    role: "user",
    content: [
      "Generate the sub-composition HTML for this scene:",
      "",
      contextBlock.join("\n"),
      "",
      `Your output MUST start with <template id="${compositionId}-template"> and end with </template>.`,
    ].join("\n"),
  });

  if (lintError) {
    messages.push({
      role: "user",
      content: [
        "Previous output for this scene failed HyperFrames lint or validate with:",
        "",
        snippet(lintError),
        "",
        "Regenerate the scene from scratch, fixing every reported issue. Common causes:",
        `  - Missing window.__timelines["${compositionId}"] registration at the end of <script>.`,
        `  - CSS selectors using [data-composition-id="..."] instead of #${compositionId} — use id form to keep rules instance-isolated.`,
        `  - GSAP selectors without the #${compositionId} prefix (e.g. '.title' instead of '#${compositionId} .title').`,
        `  - Calling document.querySelector / getElementById on the scene root inside <script> — the template content is not yet in the live DOM at script execution time. Return null references crash the timeline.`,
        "  - Infinite animations (repeat: -1) — must be finite for deterministic rendering.",
        "  - Included <!doctype html>/<html>/<body> (this is a sub-composition, not a full document).",
      ].join("\n"),
    });
  }

  return messages;
}

/**
 * Build the canonical `data-composition-id` for a scene. Format:
 * `scene-{2-digit index}-{short safe slug}`. Kept deterministic so that
 * `assembleIndexHtml` can reconstruct the file path without consulting the
 * scene record.
 */
export function sceneCompositionId(scene: Scene): string {
  const padded = String(scene.index).padStart(2, "0");
  // Derive a short ASCII-safe slug from the last 6 chars of the sceneId.
  // Skipping title-based slugs because titles carry CJK / punctuation we'd
  // have to transliterate — the sceneId hex is already a stable anchor.
  const hexTail = scene.sceneId.replace(/^sc_/, "").slice(0, 6);
  return `scene-${padded}-${hexTail}`;
}

/**
 * Canonical relative path (from composition dir) to a scene's
 * sub-composition HTML file. Used by both the sub-composition writer and
 * `assembleIndexHtml` to resolve `data-composition-src` targets.
 */
export function sceneCompositionPath(scene: Scene): string {
  return `compositions/${sceneCompositionId(scene)}.html`;
}

/**
 * Generate a single scene's sub-composition HTML via one LLM call.
 *
 * Returns the raw HTML body (inside `<template>…</template>`). The caller
 * is responsible for:
 *   1. Running `scanHtml()` to check for forbidden tokens.
 *   2. Writing the output to the project's `composition/{sceneCompositionPath}`.
 *   3. Running lint/validate on the full composition after all scenes
 *      have been written AND `assembleIndexHtml()` has produced the parent.
 *
 * On first failure, pass the lint stderr as `lintError` for a single
 * repair retry.
 */
export async function generateSceneCompositionHtml(
  project: Project,
  scene: Scene,
  opts: {
    lintError?: string;
    context?: { prevNarration?: string; nextNarration?: string };
  } = {},
): Promise<string> {
  const logger = createLogger(project.projectId, "composition");
  const referenceTemplate = await loadReferenceTemplate();

  await logger.info("scene_composition_attempt", {
    sceneId: scene.sceneId,
    compositionId: sceneCompositionId(scene),
    repair: Boolean(opts.lintError),
    referenceTemplateBytes: referenceTemplate?.length ?? 0,
  });

  const messages = buildSceneMessages(
    project,
    scene,
    opts.context ?? {},
    referenceTemplate,
    opts.lintError,
  );

  const raw = await callLLM(
    messages,
    {
      timeoutMs: TIMEOUTS_MS.LLM_COMPOSITION,
      responseFormat: "text",
      maxOutputTokens: 8192,
    },
    logger,
  );

  const html = stripCodeFences(raw);
  await logger.info("scene_composition_success", {
    sceneId: scene.sceneId,
    bytes: html.length,
  });
  return html;
}

// ---------------------------------------------------------------------------
// Deterministic assembly of the parent index.html (no LLM call)
// ---------------------------------------------------------------------------

/**
 * Assemble the parent `index.html` that mounts every scene via
 * `data-composition-src`. The parent is entirely deterministic — no LLM
 * call is required because the layout (cumulative data-start, total
 * duration, viewport) is mechanical.
 *
 * Output shape (~800 bytes regardless of scene count):
 *
 *   <!doctype html>
 *   <html lang="{locale}">
 *     <head>... viewport + GSAP ...</head>
 *     <body>
 *       <div id="root" data-composition-id="main"
 *            data-start="0" data-duration="{TOTAL}"
 *            data-width="1920" data-height="1080">
 *         <div data-composition-id="scene-01"
 *              data-composition-src="compositions/scene-01-xxx.html"
 *              data-start="0" data-duration="10" data-track-index="1"></div>
 *         ... one per scene ...
 *       </div>
 *     </body>
 *   </html>
 *
 * The parent does NOT register a root `window.__timelines["main"]` —
 * each sub-composition registers its own timeline, which the HyperFrames
 * runtime discovers during mount.
 */
export function assembleIndexHtml(project: Project): string {
  if (!project.storyboard || project.storyboard.scenes.length === 0) {
    throw new WorkbenchError(
      ErrorCode.INVALID_STAGE,
      "Storyboard required to assemble index.html",
    );
  }
  const scenes = project.storyboard.scenes;
  const locale = project.locale ?? DEFAULT_LOCALE;

  // Accumulate data-start across scenes so each child's timeline is
  // anchored at the correct point in the parent timeline.
  let cursor = 0;
  const sceneLines: string[] = [];
  for (const scene of scenes) {
    const id = sceneCompositionId(scene);
    const src = sceneCompositionPath(scene);
    sceneLines.push(
      `    <div`,
      `      data-composition-id="${id}"`,
      `      data-composition-src="${src}"`,
      `      data-start="${cursor}"`,
      `      data-track-index="1"`,
      `    ></div>`,
    );
    cursor += scene.durationSec;
  }

  const total = cursor;

  return [
    "<!doctype html>",
    `<html lang="${locale}">`,
    "<head>",
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=1920, height=1080" />',
    '  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>',
    "  <style>",
    "    * { margin: 0; padding: 0; box-sizing: border-box; }",
    "    html, body { width: 1920px; height: 1080px; overflow: hidden; background: #000; }",
    "  </style>",
    "</head>",
    "<body>",
    `  <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="1920" data-height="1080">`,
    ...sceneLines,
    "  </div>",
    "  <script>",
    "    // HyperFrames lint requires every data-composition-id root to have",
    "    // a registered timeline on window.__timelines. The parent's main",
    "    // timeline is otherwise empty — sub-composition timelines are",
    "    // auto-nested by HyperFrames based on data-start. But the framework",
    "    // uses the timeline's duration to compute composition duration:",
    `    //   \`A composition's duration equals its GSAP timeline duration\``,
    "    // An empty timeline has duration=0 → HF unmounts every clip",
    "    // immediately → sub-comp scripts still run but cannot find their",
    "    // DOM targets → 20k GSAP warnings and a black video.",
    "    // Fix: extend the timeline to the composition's data-duration with",
    "    // a zero-effect tl.set at the end, which is the official pattern",
    "    // from https://hyperframes.heygen.com/guides/gsap-animation#timeline-duration",
    "    window.__timelines = window.__timelines || {};",
    `    window.__timelines["main"] = gsap.timeline({ paused: true }).set({}, {}, ${total});`,
    "  </script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
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
