/**
 * Video Creation Workbench — shared constants.
 *
 * This module is the single source of truth for every literal value the
 * workbench code reasons about: stage ordering, voice set, schema version,
 * timeouts, retry budgets, regex patterns, directory names, and numeric
 * bounds. Every export is `as const` (or `Object.freeze`'d at the type
 * level) so the literal type information flows to schemas, routes, and UI.
 *
 * Keep this file in lockstep with `./types.ts`. A compile-time
 * exhaustiveness check at the bottom of this file forces TypeScript to
 * error if `STAGES` drifts from the `Stage` union.
 */

import type { Stage, Voice } from "./types";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/**
 * Version pin for the on-disk Project JSON schema.
 *
 * _Requirements: 2.11_
 */
export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/**
 * The 8 stages of the project state machine, in canonical forward order.
 *
 * The order here drives `STAGE_ORDER`, downstream-reset logic in
 * `state-machine.ts`, and tab gating in the UI.
 *
 * _Requirements: 1.1_
 */
export const STAGES = [
  "topic",
  "brief",
  "storyboard",
  "composition",
  "audio",
  "render",
  "qa",
  "published",
] as const satisfies readonly Stage[];

/**
 * Map from each Stage to its 0-based index in `STAGES`. Used when comparing
 * stage progress (e.g. "is current stage ≥ required stage?") — never do
 * string comparison on stages directly.
 *
 * _Requirements: 1.1_
 */
export const STAGE_ORDER: Record<Stage, number> = {
  topic: 0,
  brief: 1,
  storyboard: 2,
  composition: 3,
  audio: 4,
  render: 5,
  qa: 6,
  published: 7,
} as const;

// Compile-time exhaustiveness check — errors here mean `STAGES` has drifted
// from the `Stage` union in `./types.ts`.
const _stagesExhaustive: readonly Stage[] = STAGES;
void _stagesExhaustive;

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

/**
 * Curated list of Azure Cognitive Services TTS voices shown in the UI
 * voice picker. All are Chinese voices from the Azure AI Foundry endpoint.
 * The full Azure voice catalogue is much larger — these are the ones
 * surfaced in the workbench UI.
 *
 * _Requirements: 3.6, 9.5_
 */
export const VOICES = [
  "zh-CN-Xiaochen:DragonHDFlashLatestNeural",
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-YunxiNeural",
  "zh-CN-YunjianNeural",
  "zh-CN-XiaoyiNeural",
  "zh-CN-YunyangNeural",
  "zh-CN-XiaochenNeural",
  "zh-CN-XiaohanNeural",
] as const satisfies readonly Voice[];

/**
 * Default voice used when a Scene omits one or when the provided voice is
 * not in the curated list (TTSService falls back and logs a "voice fallback"
 * event).
 *
 * _Requirements: 3.6, 9.5_
 */
export const DEFAULT_VOICE: Voice = "zh-CN-Xiaochen:DragonHDFlashLatestNeural";

// No exhaustiveness check needed — Voice is now `string`, not a union.

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

/**
 * Default locale applied when `CreateProjectInput.locale` is omitted.
 *
 * _Requirements: 4.7_
 */
export const DEFAULT_LOCALE = "zh-CN" as const;

// ---------------------------------------------------------------------------
// Filesystem paths
// ---------------------------------------------------------------------------

/**
 * Root directory for Project JSON + per-project directories. Relative to
 * `content-analyzer/web`.
 *
 * _Requirements: 2.1, 8.1_
 */
export const DATA_DIR = "data/projects" as const;

/**
 * Root directory for rendered MP4s served by Next.js's static handler.
 * Relative to `content-analyzer/web`.
 *
 * _Requirements: 10.4_
 */
export const VIDEO_DIR = "public/videos" as const;

/**
 * Per-project subdirectory names inside
 * `data/projects/{projectId}/composition/` and `data/projects/{projectId}/`.
 *
 * _Requirements: 8.1, 14.2_
 */
export const STAGE_DIRS = {
  COMPOSITION: "composition",
  ASSETS: "assets",
  FONTS: "fonts",
  LOGS: "logs",
} as const;

// ---------------------------------------------------------------------------
// Scene count bounds (exposed as individual constants for readability)
// ---------------------------------------------------------------------------

/**
 * Minimum and maximum Scene count per Storyboard. Enforced by schemas,
 * scene CRUD routes, and the storyboard LLM prompt.
 *
 * _Requirements: 5.3, 5.10_
 */
export const MIN_SCENES = 3 as const;
export const MAX_SCENES = 20 as const;

// ---------------------------------------------------------------------------
// LIMITS — numeric/length bounds used across the workbench
// ---------------------------------------------------------------------------

/**
 * Every numeric / length bound the spec calls out, grouped by subject.
 *
 * _Requirements: 2.2, 3.1, 3.4, 3.5, 3.7, 4.2, 5.3, 5.4, 6.4, 7.1, 7.3, 7.5,
 * 9.1, 10.6, 11.1, 11.4, 11.9, 12.9, 14.1, 14.3, 14.5, 14.7, 16.1, 16.5_
 */
export const LIMITS = {
  // Project — top-level fields
  /** Project.title max (1–200). _Req 2.2_ */
  TITLE_MAX: 200,
  /** New-project form title max (1–80). _Req 11.4_ */
  PROJECT_TITLE_MAX: 80,
  /** Project.topic max (1–500). _Req 2.2, 11.4_ */
  TOPIC_MAX: 500,

  // Brief
  /** Brief.title (1–60). _Req 4.2_ */
  BRIEF_TITLE_MAX: 60,
  /** Brief.audience (1–200). _Req 4.2_ */
  BRIEF_AUDIENCE_MAX: 200,
  /** Brief.tone (1–60). _Req 4.2_ */
  BRIEF_TONE_MAX: 60,
  /** Brief.corePoints entry max (1–200). _Req 4.2_ */
  BRIEF_CORE_POINT_MAX: 200,
  /** Brief.corePoints array bounds (3–5). _Req 4.2_ */
  BRIEF_CORE_POINTS_MIN: 3,
  BRIEF_CORE_POINTS_MAX: 5,
  /** Brief.suggestedStyle (1–200). _Req 4.2_ */
  BRIEF_STYLE_MAX: 200,
  /** Brief.targetDurationSec integer bounds (20–180). _Req 4.2_ */
  BRIEF_TARGET_DURATION_MIN: 20,
  BRIEF_TARGET_DURATION_MAX: 180,

  // Scene
  /** Scene.title (1–40). _Req 3.1_ */
  SCENE_TITLE_MAX: 40,
  /** Scene.narration at storyboard time (1–280). _Req 3.1, 5.3_ */
  SCENE_NARRATION_MAX: 280,
  /** Scene.narration after QA rewrite (≤2000). _Req 7.1_ */
  SCENE_NARRATION_MAX_POST_REWRITE: 2000,
  /** Minimum narration length for rewrite output (≥10). _Req 7.1_ */
  SCENE_NARRATION_MIN_REWRITE: 10,
  /** Scene.durationSec general bounds (1–60). _Req 3.4_ */
  SCENE_DURATION_MIN: 1,
  SCENE_DURATION_MAX: 60,
  /** Storyboard-time duration bounds (2–30). _Req 5.3_ */
  SCENE_DURATION_MIN_STORYBOARD: 2,
  SCENE_DURATION_MAX_STORYBOARD: 30,
  /** Scene rewrite duration bounds (3–300). _Req 7.1_ */
  SCENE_DURATION_MIN_REWRITE: 3,
  SCENE_DURATION_MAX_REWRITE: 300,

  // QA notes
  /** Scene.qaNote max (0–2000). _Req 3.7, 12.10_ */
  QA_NOTE_MAX: 2000,
  /** qaNote payload for POST rewrite (1–500). _Req 7.1_ */
  QA_NOTE_REWRITE_MAX: 500,

  // Error envelope / generic strings
  /** Transition reason / generic reason string max. _Req 1.6, 14.7_ */
  REASON_MAX: 500,
  /** ErrorResponse.error.message max. _Req 14.1, 14.7_ */
  ERROR_MESSAGE_MAX: 500,
  /** ErrorResponse.error.code max. _Req 14.1_ */
  ERROR_CODE_MAX: 64,

  // Input-safety general bounds
  /** Ordinary string field max. _Req 16.1_ */
  STRING_FIELD_MAX: 4000,
  /** Free-text field max (narration, qaNote, prompt passthroughs). _Req 16.1_ */
  FREE_TEXT_MAX: 20_000,

  // Request body limits
  /** Default request body max (1 MB). _Req 16.5_ */
  REQUEST_BODY_MAX_BYTES: 1 * 1024 * 1024,
  /** Generation endpoints request body max (4 MB). _Req 16.5_ */
  REQUEST_BODY_MAX_BYTES_GEN: 4 * 1024 * 1024,

  // Logging
  /** Per-stage log rotation threshold (10 MB). _Req 14.3_ */
  LOG_FILE_MAX_BYTES: 10 * 1024 * 1024,
  /** Max rotated log history kept on disk. _Req 14.3_ */
  LOG_HISTORY_MAX: 3,
  /** Default log tail size returned by "view full log" (lines). _Req 14.5_ */
  LOG_TAIL_DEFAULT: 500,

  // Storyboard / composition tolerances
  /** Storyboard scene-count bounds (3–20). _Req 5.3_ */
  STORYBOARD_MIN_SCENES: MIN_SCENES,
  STORYBOARD_MAX_SCENES: MAX_SCENES,
  /** Storyboard total-duration tolerance vs Brief.targetDurationSec (±15%). _Req 5.4_ */
  STORYBOARD_TOLERANCE_PCT: 0.15,
  /** Scene-rewrite duration tolerance (±30%) when no keyword override. _Req 7.3_ */
  REWRITE_DURATION_TOLERANCE_PCT: 0.30,
  /** If storyboard total changes > this after rewrite, regen HTML. _Req 7.5_ */
  COMPOSITION_REGEN_THRESHOLD_PCT: 0.10,
  /** Composition root-timeline vs sum-of-durationSec tolerance. _Req 6.4_ */
  COMPOSITION_TIMELINE_TOLERANCE_SEC: 0.5,
  /** Fixed render frame-rate passed to `hyperframes render`. _Req 10.1_ */
  RENDER_FPS: 30,

  // List / UI pagination
  /** Page size on `/projects` list. _Req 11.9_ */
  PROJECTS_PER_PAGE: 20,
  /** projectId collision retry budget at creation time. _Req 2.3_ */
  PROJECT_ID_RETRY: 5,

  // Failure heuristics
  /** Consecutive stage failures before surfacing a "roll back" hint. _Req 14.8_ */
  CONSECUTIVE_FAILURE_THRESHOLD: 3,
} as const;

// ---------------------------------------------------------------------------
// TIMEOUTS_MS — operation-level timeouts (all in milliseconds)
// ---------------------------------------------------------------------------

/**
 * Hard timeouts applied to every external or long-running operation.
 *
 * _Requirements: 1.10, 4.1, 4.3, 5.1, 6.1, 6.5, 7.7, 9.6, 10.6, 10.7, 14.6_
 */
export const TIMEOUTS_MS = {
  /** topic → brief per-attempt LLM budget. _Req 4.1, 4.3_ */
  LLM_BRIEF: 60_000,
  /** brief → storyboard per-attempt LLM budget. _Req 5.1_ */
  LLM_STORYBOARD: 60_000,
  /** storyboard → HTML per-attempt LLM budget. _Req 6.1_ */
  LLM_COMPOSITION: 180_000,
  /** QA → scene rewrite per-attempt LLM budget. _Req 7.7_ */
  LLM_REWRITE: 60_000,
  /** Single Azure TTS call budget. _Req 9.6_ */
  TTS_CALL: 60_000,
  /** `npx hyperframes lint` per-invocation budget. _Req 6.5_ */
  HYPERFRAMES_LINT: 30_000,
  /** `npx hyperframes validate` per-invocation budget. _Req 6.5_ */
  HYPERFRAMES_VALIDATE: 30_000,
  /** Full `npx hyperframes render` subprocess budget. _Req 10.6_ */
  HYPERFRAMES_RENDER: 180_000,
  /** SSE heartbeat / progress-push cadence for render stream. _Req 10.7_ */
  SSE_HEARTBEAT_INTERVAL: 2_000,
  /** Upper bound for any single stage to reach a terminal state. _Req 1.10_ */
  STAGE_HARD_CEILING: 3_600_000,
  /** API-level hard cap for any single external request. _Req 14.6_ */
  API_REQUEST_HARD_CAP: 120_000,
} as const;

// ---------------------------------------------------------------------------
// Retry budgets & backoff schedules
// ---------------------------------------------------------------------------

/**
 * Azure Cognitive Services Speech REST API output format for TTS.
 * 16 kHz, 128 kbps mono MP3 — good quality / size balance.
 *
 * _Requirements: 9.5_
 */
export const AZURE_TTS_OUTPUT_FORMAT = "audio-16khz-128kbitrate-mono-mp3" as const;

/**
 * TTS retry delays (ms). First attempt waits 0 ms; then retry after 1 s,
 * then after 3 s. Total attempts bounded by `TTS_MAX_ATTEMPTS`.
 *
 * _Requirements: 9.6_
 */
export const TTS_BACKOFF_MS = [0, 1_000, 3_000] as const;

/** _Requirements: 9.6_ */
export const TTS_MAX_ATTEMPTS = 3 as const;

/** Brief generation: 1 initial + up to 2 retries = 3 total. _Req 4.3_ */
export const LLM_BRIEF_MAX_ATTEMPTS = 3 as const;

/** Storyboard tolerance retry budget: 1 initial + 1 retry = 2 total. _Req 5.5_ */
export const LLM_STORYBOARD_MAX_ATTEMPTS = 2 as const;

/** Composition repair retry budget: 1 initial + 1 repair = 2 total. _Req 6.6_ */
export const LLM_COMPOSITION_MAX_ATTEMPTS = 2 as const;

/**
 * Max number of per-scene LLM calls in flight at once during
 * scene-sharded composition generation (Plan A). Going higher gets you
 * more throughput but also raises the risk of server-side rate limiting
 * on kiro-cli and spikes local RAM / FD usage. Tuned conservatively —
 * raise once you have production failure-rate data.
 *
 * Override with `SCENE_GEN_CONCURRENCY` env var.
 */
export const SCENE_GEN_CONCURRENCY_DEFAULT = 4 as const;

/** Scene rewrite never retries automatically. _Req 7.7_ */
export const LLM_REWRITE_MAX_ATTEMPTS = 1 as const;

/**
 * Per-task LLM timeout lookup (alias over `TIMEOUTS_MS` for call sites that
 * think in task names rather than operation names).
 *
 * _Requirements: 4.1, 5.1, 6.1, 7.7_
 */
export const LLM_TIMEOUT_MS = {
  brief: TIMEOUTS_MS.LLM_BRIEF,
  storyboard: TIMEOUTS_MS.LLM_STORYBOARD,
  composition: TIMEOUTS_MS.LLM_COMPOSITION,
  rewrite: TIMEOUTS_MS.LLM_REWRITE,
} as const;

// ---------------------------------------------------------------------------
// REGEX — compiled once, exported as RegExp
// ---------------------------------------------------------------------------

/**
 * Identifier regex patterns. Compiled once here so schemas and path-safety
 * checks share the exact same literal.
 *
 * _Requirements: 2.3, 3.2, 8.7, 16.4_
 */
export const REGEX = {
  /** Project ID shape: `proj_{ms-timestamp}_{6 lowercase alphanum}`. _Req 2.3_ */
  PROJECT_ID: /^proj_[0-9]+_[a-z0-9]{6}$/,
  /** Scene ID shape: `sc_{8 lowercase hex}`. _Req 3.2_ */
  SCENE_ID: /^sc_[a-z0-9]{8}$/,
  /** QA note ID shape: `qan_{8 lowercase hex}`. _Req 3.1_ */
  QA_NOTE_ID: /^qan_[a-z0-9]{8}$/,
} as const;

/**
 * ASCII control-character class used by `scrubControlChars`. Matches
 * 0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F, 0x7F.
 *
 * _Requirements: 16.3_
 */
export const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

// ---------------------------------------------------------------------------
// Keyword / token lists
// ---------------------------------------------------------------------------

/**
 * Keywords that, when present in a QA note, signal the user explicitly
 * wants a duration change — relaxing the ±30 % tolerance in
 * `LIMITS.REWRITE_DURATION_TOLERANCE_PCT`. Match is case-insensitive.
 *
 * _Requirements: 7.3_
 */
export const REWRITE_DURATION_KEYWORDS = [
  "改时长",
  "change duration",
  "缩短",
  "加长",
  "shorten",
  "lengthen",
] as const;

/**
 * Forbidden substrings scanned (case-insensitive) against LLM-returned HTML
 * before it is ever written to disk. If any token matches, the output is
 * rejected and the composition-stage repair loop kicks in.
 *
 * _Requirements: 6.3, 16.7_
 */
export const HTML_FORBIDDEN_TOKENS = [
  "<iframe",
  "<object",
  "<embed",
  "fetch(",
  "XMLHttpRequest",
  "Date.now(",
  "Math.random(",
] as const;

// ---------------------------------------------------------------------------
// Tab gating
// ---------------------------------------------------------------------------

/**
 * Identifier for each of the 6 tabs on `/projects/[id]`.
 *
 * _Requirements: 12.2_
 */
export type TabName = "brief" | "storyboard" | "html" | "audio" | "render" | "qa";

/**
 * Minimum Stage a Project must have reached before a given tab's controls
 * are enabled. `STAGE_ORDER` is used for comparison.
 *
 * _Requirements: 12.11_
 */
export const TAB_MIN_STAGE: Record<TabName, Stage> = {
  brief: "brief",
  storyboard: "storyboard",
  html: "composition",
  audio: "composition",
  render: "audio",
  qa: "render",
} as const;
