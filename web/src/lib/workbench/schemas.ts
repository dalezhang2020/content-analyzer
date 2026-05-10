/**
 * Video Creation Workbench — zod runtime schemas.
 *
 * These schemas are the single source of truth at every API boundary:
 *   - Route Handlers validate request bodies and inputs with these schemas
 *     before touching the filesystem or spawning LLM/TTS calls.
 *   - `project-store` re-validates the on-disk JSON on read so corrupt or
 *     hand-edited files surface as `SCHEMA_VERSION_MISMATCH` /
 *     `INVALID_PROJECT` rather than silently propagating bad data.
 *   - LLM output parsers (brief/storyboard/rewrite) pipe raw JSON through
 *     the matching schema before merging into the Project.
 *
 * The inferred types MUST match `./types.ts` exactly; that file is the
 * contract the rest of the app programs against. A round-trip over
 * `ProjectSchema.parse(validProject)` must be structurally identical to the
 * input — Property 5 in the task list pins this invariant.
 *
 * Control-character rejection: text fields that originate from user input or
 * LLM output flow through `safeStr()`, which refuses any string containing
 * `CONTROL_CHAR_REGEX` matches. This prevents log injection, terminal
 * escape sequences, and NUL-byte smuggling into persisted JSON.
 *
 * _Requirements: 2.2, 2.11, 3.1, 3.4, 3.5, 3.6, 3.7, 14.1, 14.7, 16.1, 16.3_
 */

import { z } from "zod";

import {
  CONTROL_CHAR_REGEX,
  DEFAULT_VOICE,
  LIMITS,
  MAX_SCENES,
  MIN_SCENES,
  REGEX,
  SCHEMA_VERSION,
  STAGES,
} from "./constants";
import type { Stage } from "./types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Predicate: true when `s` is free of ASCII control characters matched by
 * `CONTROL_CHAR_REGEX`.
 */
const noControlChars = (s: string): boolean => !CONTROL_CHAR_REGEX.test(s);

/**
 * Wraps a `z.string()` builder with a `.refine()` that rejects control
 * characters. Apply `.min()` / `.max()` / `.regex()` on the `z.string()`
 * argument first — `.refine()` returns `ZodEffects` which doesn't expose
 * those methods.
 *
 * Use for every free-text field that originates from user or LLM input.
 */
function safeStr(
  s: z.ZodString = z.string(),
): z.ZodEffects<z.ZodString, string, string> {
  return s.refine(noControlChars, "Contains control characters");
}

// ---------------------------------------------------------------------------
// Stage / stage status
// ---------------------------------------------------------------------------

export const StageSchema = z.enum(STAGES);

export const StageStatusValueSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export const StageStatusSchema = z.object({
  status: StageStatusValueSchema,
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  error: z
    .object({
      code: z.string().max(LIMITS.ERROR_CODE_MAX),
      message: z.string().max(LIMITS.ERROR_MESSAGE_MAX),
    })
    .optional(),
  attempts: z.number().int().min(0).optional(),
});

/**
 * Object with every Stage key mapping to `StageStatusSchema`. Built from
 * `STAGES` so adding a new stage never silently drops validation.
 */
export const StageStatusMapSchema = z.object(
  Object.fromEntries(
    STAGES.map((s) => [s, StageStatusSchema]),
  ) as Record<Stage, typeof StageStatusSchema>,
);

export const StageHistoryEntrySchema = z.object({
  fromStage: StageSchema,
  toStage: StageSchema,
  at: z.string().datetime(),
  reason: safeStr(z.string().max(LIMITS.REASON_MAX)).optional(),
  result: z.enum(["success", "failure"]),
});

// ---------------------------------------------------------------------------
// Artifacts / template source
// ---------------------------------------------------------------------------

export const ArtifactPathsSchema = z.object({
  briefPath: z.string().nullable(),
  storyboardPath: z.string().nullable(),
  compositionDir: z.string().nullable(),
  indexHtmlPath: z.string().nullable(),
  hyperframesJsonPath: z.string().nullable(),
  audioPaths: z.array(z.string()),
  videoPath: z.string().nullable(),
});

export const TemplateSourceSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  sourcePath: z.string().min(1),
});

// ---------------------------------------------------------------------------
// QA notes
// ---------------------------------------------------------------------------

export const QaNoteSchema = z.object({
  noteId: z.string().regex(REGEX.QA_NOTE_ID),
  sceneId: z.string().regex(REGEX.SCENE_ID).nullable(),
  text: safeStr(z.string().max(LIMITS.QA_NOTE_MAX)),
  author: z.literal("local"),
  createdAt: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Brief / voice / scene / storyboard
// ---------------------------------------------------------------------------

export const BriefSchema = z.object({
  title: safeStr(z.string().min(1).max(LIMITS.BRIEF_TITLE_MAX)),
  audience: safeStr(z.string().min(1).max(LIMITS.BRIEF_AUDIENCE_MAX)),
  corePoints: z
    .array(safeStr(z.string().min(1).max(LIMITS.BRIEF_CORE_POINT_MAX)))
    .min(LIMITS.BRIEF_CORE_POINTS_MIN)
    .max(LIMITS.BRIEF_CORE_POINTS_MAX),
  tone: safeStr(z.string().min(1).max(LIMITS.BRIEF_TONE_MAX)),
  targetDurationSec: z
    .number()
    .int()
    .min(LIMITS.BRIEF_TARGET_DURATION_MIN)
    .max(LIMITS.BRIEF_TARGET_DURATION_MAX),
  suggestedStyle: safeStr(z.string().min(1).max(LIMITS.BRIEF_STYLE_MAX)),
});

export const VoiceSchema = z.string().min(1).max(200);

export const SceneSchema = z.object({
  sceneId: z.string().regex(REGEX.SCENE_ID),
  index: z.number().int().min(1),
  title: safeStr(z.string().min(1).max(LIMITS.SCENE_TITLE_MAX)),
  narration: safeStr(
    z.string().min(1).max(LIMITS.SCENE_NARRATION_MAX_POST_REWRITE),
  ),
  durationSec: z
    .number()
    .int()
    .min(LIMITS.SCENE_DURATION_MIN)
    .max(LIMITS.SCENE_DURATION_MAX),
  voice: VoiceSchema,
  audioPath: z.string().nullable(),
  qaNote: safeStr(z.string().max(LIMITS.QA_NOTE_MAX)),
  updatedAt: z.string().datetime(),
});

export const StoryboardSchema = z.object({
  scenes: z.array(SceneSchema).min(MIN_SCENES).max(MAX_SCENES),
});

// ---------------------------------------------------------------------------
// Project (root aggregate)
// ---------------------------------------------------------------------------

export const ProjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  projectId: z.string().regex(REGEX.PROJECT_ID),
  title: safeStr(z.string().min(1).max(LIMITS.TITLE_MAX)),
  topic: safeStr(z.string().min(1).max(LIMITS.TOPIC_MAX)),
  locale: z.enum(["zh-CN", "en-US"]),
  stage: StageSchema,
  stageStatus: StageStatusMapSchema,
  stageHistory: z.array(StageHistoryEntrySchema),
  brief: BriefSchema.nullable(),
  storyboard: StoryboardSchema.nullable(),
  artifacts: ArtifactPathsSchema,
  qaNotes: z.array(QaNoteSchema),
  templateSource: TemplateSourceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// API shape helpers
// ---------------------------------------------------------------------------

export const ProjectSummarySchema = z.object({
  projectId: z.string().regex(REGEX.PROJECT_ID),
  title: safeStr(z.string().min(1).max(LIMITS.TITLE_MAX)),
  stage: StageSchema,
  updatedAt: z.string().datetime(),
  posterUrl: z.string().nullable().optional(),
  videoUrl: z.string().nullable().optional(),
});

/**
 * Request body for `POST /api/projects`.
 *
 * `title` and `topic` are `.trim()`-ed before length validation so leading/
 * trailing whitespace is never persisted and never counts toward the max
 * length. The control-character refine runs last so trimmed strings that
 * still contain embedded control bytes are rejected.
 *
 * _Requirements: 11.4, 16.1, 16.3_
 */
export const CreateProjectInputSchema = z.object({
  title: safeStr(
    z.string().trim().min(1).max(LIMITS.PROJECT_TITLE_MAX),
  ),
  topic: safeStr(z.string().trim().min(1).max(LIMITS.TOPIC_MAX)),
  locale: z.enum(["zh-CN", "en-US"]).optional(),
});

// ---------------------------------------------------------------------------
// Scene CRUD / rewrite input + output schemas
// ---------------------------------------------------------------------------

export const SceneEditableSchema = z.object({
  title: safeStr(z.string().min(1).max(LIMITS.SCENE_TITLE_MAX)).optional(),
  narration: safeStr(
    z.string().min(1).max(LIMITS.SCENE_NARRATION_MAX_POST_REWRITE),
  ).optional(),
  durationSec: z
    .number()
    .int()
    .min(LIMITS.SCENE_DURATION_MIN)
    .max(LIMITS.SCENE_DURATION_MAX)
    .optional(),
  voice: VoiceSchema.optional(),
  qaNote: safeStr(z.string().max(LIMITS.QA_NOTE_MAX)).optional(),
});

/**
 * Request body for `POST /api/projects/{id}/scenes/bulk-voice`. Applies a
 * single `voice` to every scene in the project's storyboard in one atomic
 * write, clearing `audioPath` on every scene whose voice actually changes
 * (Property 10). Topic and brief edits are not covered — the route guard
 * rejects missing-storyboard calls with `INVALID_STAGE`.
 */
export const BulkSceneVoiceSchema = z.object({
  voice: VoiceSchema,
});

export const SceneCreateInputSchema = z.object({
  title: safeStr(z.string().min(1).max(LIMITS.SCENE_TITLE_MAX)),
  narration: safeStr(
    z.string().min(1).max(LIMITS.SCENE_NARRATION_MAX_POST_REWRITE),
  ),
  durationSec: z
    .number()
    .int()
    .min(LIMITS.SCENE_DURATION_MIN)
    .max(LIMITS.SCENE_DURATION_MAX),
  voice: VoiceSchema.default(DEFAULT_VOICE),
});

export const SceneRewriteInputSchema = z.object({
  qaNote: safeStr(z.string().min(1).max(LIMITS.QA_NOTE_REWRITE_MAX)),
});

export const SceneRewriteOutputSchema = z.object({
  narration: safeStr(
    z
      .string()
      .min(LIMITS.SCENE_NARRATION_MIN_REWRITE)
      .max(LIMITS.SCENE_NARRATION_MAX_POST_REWRITE),
  ),
  durationSec: z
    .number()
    .int()
    .min(LIMITS.SCENE_DURATION_MIN_REWRITE)
    .max(LIMITS.SCENE_DURATION_MAX_REWRITE)
    .optional(),
});

/**
 * Raw LLM output for the storyboard stage. Narration and duration bounds
 * are narrower than `SceneSchema` because storyboard generation produces
 * short scenes that may grow post-QA rewrite.
 */
export const StoryboardOutputSchema = z.object({
  scenes: z
    .array(
      z.object({
        title: safeStr(z.string().min(1).max(LIMITS.SCENE_TITLE_MAX)),
        narration: safeStr(
          z.string().min(1).max(LIMITS.SCENE_NARRATION_MAX),
        ),
        durationSec: z
          .number()
          .int()
          .min(LIMITS.SCENE_DURATION_MIN_STORYBOARD)
          .max(LIMITS.SCENE_DURATION_MAX_STORYBOARD),
        voice: VoiceSchema,
      }),
    )
    .min(MIN_SCENES)
    .max(MAX_SCENES),
});

// ---------------------------------------------------------------------------
// Error envelope / auxiliary request bodies
// ---------------------------------------------------------------------------

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().max(LIMITS.ERROR_CODE_MAX),
    message: z.string().max(LIMITS.ERROR_MESSAGE_MAX),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const QaNoteInputSchema = z.object({
  sceneId: z.string().regex(REGEX.SCENE_ID).nullable().optional(),
  text: safeStr(z.string().min(1).max(LIMITS.QA_NOTE_MAX)),
});

/** Publish endpoint takes no body; accept empty object or undefined. */
export const PublishInputSchema = z.object({}).optional();

/**
 * Request body for `POST /api/projects/{id}/regress`. Manual stage
 * regression — `target` must be a known `Stage` strictly earlier than
 * the project's current stage (enforced by `regressToStage`, not the
 * schema). Optional `reason` is captured in the history entry and
 * truncated to `LIMITS.REASON_MAX` by the state-machine helper.
 *
 * _Requirements: 1.4, 1.5_
 */
export const RegressInputSchema = z.object({
  target: StageSchema,
  reason: safeStr(z.string().min(1).max(LIMITS.REASON_MAX)).optional(),
});

export const ForceFlagSchema = z.object({
  force: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Inferred type aliases (for schemas that don't already have a matching
// type in `./types.ts`)
// ---------------------------------------------------------------------------

export type ProjectInput = z.infer<typeof CreateProjectInputSchema>;
export type SceneEditableInput = z.infer<typeof SceneEditableSchema>;
export type SceneCreateInput = z.infer<typeof SceneCreateInputSchema>;
export type BulkSceneVoiceInput = z.infer<typeof BulkSceneVoiceSchema>;
export type SceneRewriteInput = z.infer<typeof SceneRewriteInputSchema>;
export type SceneRewriteOutput = z.infer<typeof SceneRewriteOutputSchema>;
export type StoryboardOutput = z.infer<typeof StoryboardOutputSchema>;
export type QaNoteInput = z.infer<typeof QaNoteInputSchema>;
export type PublishInput = z.infer<typeof PublishInputSchema>;
export type ForceFlag = z.infer<typeof ForceFlagSchema>;
export type RegressInput = z.infer<typeof RegressInputSchema>;
