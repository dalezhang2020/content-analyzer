import fc from "fast-check";

import {
  CONTROL_CHAR_REGEX,
  LIMITS,
  MAX_SCENES,
  MIN_SCENES,
  STAGES,
} from "@/lib/workbench/constants";
import type {
  ArtifactPaths,
  Brief,
  Project,
  QaNote,
  Scene,
  Stage,
  StageHistoryEntry,
  StageStatus,
  StageStatusMap,
  StageStatusValue,
  Storyboard,
  TemplateSource,
} from "@/lib/workbench/types";

// Feature: video-creation-workbench
//
// Full-fidelity fast-check arbitraries for the Project aggregate and its
// sub-shapes. These generators are the single source of PBT inputs for
// `schemas.test.ts` (Property 5 round-trip) and for any future property
// test that needs a valid Project.
//
// Design notes:
//   - Every generated value satisfies `ProjectSchema.parse()` unconditionally.
//     No `.filter` rejections at the top level, so fast-check can explore
//     efficiently.
//   - Strings are drawn from printable ASCII (fc.string defaults to 0x20–0x7E)
//     and additionally filtered to `CONTROL_CHAR_REGEX` just in case fast-check
//     ever widens its default charset.
//   - Datetimes go through `Date → toISOString()` so they always satisfy
//     `z.string().datetime()` (RFC 3339 with trailing `Z`).
//   - Optional fields are generated via `.option()` on nested arbitraries so
//     the output drops the key entirely when `undefined` — matches the
//     `JSON.stringify` → `JSON.parse` round-trip shape.

// Re-export the STAGES tuple for backward-compat with tests that still import
// the canonical stage list from this module (pre-T08 smoke test does that).
export { STAGES } from "@/lib/workbench/constants";
export type { Stage } from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// Primitive string / id arbitraries
// ---------------------------------------------------------------------------

const safeString = (opts: {
  minLength?: number;
  maxLength: number;
}): fc.Arbitrary<string> =>
  fc
    .string({ minLength: opts.minLength ?? 0, maxLength: opts.maxLength })
    .filter((s) => !CONTROL_CHAR_REGEX.test(s));

const LOWER_ALPHANUM = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

const lowerAlnum = (len: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...LOWER_ALPHANUM), {
      minLength: len,
      maxLength: len,
    })
    .map((chars) => chars.join(""));

export const projectIdArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 1_700_000_000_000, max: 2_000_000_000_000 }),
    lowerAlnum(6),
  )
  .map(([ts, suffix]) => `proj_${ts}_${suffix}`);

export const sceneIdArb: fc.Arbitrary<string> = lowerAlnum(8).map(
  (hex) => `sc_${hex}`,
);

export const noteIdArb: fc.Arbitrary<string> = lowerAlnum(8).map(
  (hex) => `qan_${hex}`,
);

// ISO 8601 UTC timestamps (`YYYY-MM-DDTHH:mm:ss.sssZ`).
export const isoDateArb: fc.Arbitrary<string> = fc
  .date({
    min: new Date("2020-01-01T00:00:00Z"),
    max: new Date("2099-12-31T23:59:59Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

// ---------------------------------------------------------------------------
// Stage / stage-status arbitraries
// ---------------------------------------------------------------------------

export const stageArb: fc.Arbitrary<Stage> = fc.constantFrom(...STAGES);

const stageStatusValueArb: fc.Arbitrary<StageStatusValue> = fc.constantFrom(
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
);

const stageErrorArb: fc.Arbitrary<{ code: string; message: string }> = fc.record(
  {
    code: safeString({
      minLength: 1,
      maxLength: LIMITS.ERROR_CODE_MAX,
    }),
    message: safeString({ maxLength: LIMITS.ERROR_MESSAGE_MAX }),
  },
);

/**
 * StageStatus with optional startedAt / finishedAt / error / attempts. The
 * generator uses `fc.option(..., { nil: undefined })` so the key is dropped
 * from the output object when "absent" — matches the JSON round-trip shape.
 */
export const stageStatusArb: fc.Arbitrary<StageStatus> = fc
  .record(
    {
      status: stageStatusValueArb,
      startedAt: fc.option(isoDateArb, { nil: undefined }),
      finishedAt: fc.option(isoDateArb, { nil: undefined }),
      error: fc.option(stageErrorArb, { nil: undefined }),
      attempts: fc.option(fc.integer({ min: 0, max: 100 }), {
        nil: undefined,
      }),
    },
    { requiredKeys: ["status"] },
  )
  .map((raw) => {
    // Drop keys whose value is explicitly `undefined` so JSON.stringify /
    // zod.parse round-trips don't introduce ghost keys.
    const out: StageStatus = { status: raw.status };
    if (raw.startedAt !== undefined) out.startedAt = raw.startedAt;
    if (raw.finishedAt !== undefined) out.finishedAt = raw.finishedAt;
    if (raw.error !== undefined) out.error = raw.error;
    if (raw.attempts !== undefined) out.attempts = raw.attempts;
    return out;
  });

/** StageStatusMap arb: one StageStatus for every Stage in the canonical order. */
export const stageStatusMapArb: fc.Arbitrary<StageStatusMap> = fc
  .tuple(
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
    stageStatusArb,
  )
  .map(
    ([topic, brief, storyboard, composition, audio, render, qa, published]) => ({
      topic,
      brief,
      storyboard,
      composition,
      audio,
      render,
      qa,
      published,
    }),
  );

export const stageHistoryEntryArb: fc.Arbitrary<StageHistoryEntry> = fc
  .record(
    {
      fromStage: stageArb,
      toStage: stageArb,
      at: isoDateArb,
      reason: fc.option(safeString({ maxLength: LIMITS.REASON_MAX }), {
        nil: undefined,
      }),
      result: fc.constantFrom<"success" | "failure">("success", "failure"),
    },
    { requiredKeys: ["fromStage", "toStage", "at", "result"] },
  )
  .map((raw) => {
    const out: StageHistoryEntry = {
      fromStage: raw.fromStage,
      toStage: raw.toStage,
      at: raw.at,
      result: raw.result,
    };
    if (raw.reason !== undefined) out.reason = raw.reason;
    return out;
  });

// ---------------------------------------------------------------------------
// Brief / Scene / Storyboard / QaNote / artifacts / templateSource
// ---------------------------------------------------------------------------

export const briefArb: fc.Arbitrary<Brief> = fc.record({
  title: safeString({ minLength: 1, maxLength: LIMITS.BRIEF_TITLE_MAX }),
  audience: safeString({
    minLength: 1,
    maxLength: LIMITS.BRIEF_AUDIENCE_MAX,
  }),
  corePoints: fc.array(
    safeString({ minLength: 1, maxLength: LIMITS.BRIEF_CORE_POINT_MAX }),
    {
      minLength: LIMITS.BRIEF_CORE_POINTS_MIN,
      maxLength: LIMITS.BRIEF_CORE_POINTS_MAX,
    },
  ),
  tone: safeString({ minLength: 1, maxLength: LIMITS.BRIEF_TONE_MAX }),
  targetDurationSec: fc.integer({
    min: LIMITS.BRIEF_TARGET_DURATION_MIN,
    max: LIMITS.BRIEF_TARGET_DURATION_MAX,
  }),
  suggestedStyle: safeString({
    minLength: 1,
    maxLength: LIMITS.BRIEF_STYLE_MAX,
  }),
});

// Voice: free-form string 1–200 chars, no control chars. Kept narrow for PBT
// perf (short printable strings) — the schema only enforces 1–200 anyway.
const voiceArb: fc.Arbitrary<string> = safeString({
  minLength: 1,
  maxLength: 60,
});

export const sceneArb: fc.Arbitrary<Scene> = fc.record({
  sceneId: sceneIdArb,
  index: fc.integer({ min: 1, max: MAX_SCENES }),
  title: safeString({ minLength: 1, maxLength: LIMITS.SCENE_TITLE_MAX }),
  // Use post-rewrite upper bound — ProjectSchema allows up to this length.
  narration: safeString({
    minLength: 1,
    maxLength: LIMITS.SCENE_NARRATION_MAX_POST_REWRITE,
  }),
  durationSec: fc.integer({
    min: LIMITS.SCENE_DURATION_MIN,
    max: LIMITS.SCENE_DURATION_MAX,
  }),
  voice: voiceArb,
  audioPath: fc.option(safeString({ maxLength: 120 }), { nil: null }),
  qaNote: safeString({ maxLength: LIMITS.QA_NOTE_MAX }),
  updatedAt: isoDateArb,
});

export const storyboardArb: fc.Arbitrary<Storyboard> = fc
  .array(sceneArb, { minLength: MIN_SCENES, maxLength: MAX_SCENES })
  .map((scenes) => ({ scenes }));

export const qaNoteArb: fc.Arbitrary<QaNote> = fc.record({
  noteId: noteIdArb,
  sceneId: fc.option(sceneIdArb, { nil: null }),
  text: safeString({ maxLength: LIMITS.QA_NOTE_MAX }),
  author: fc.constant<"local">("local"),
  createdAt: isoDateArb,
});

const artifactPathsArb: fc.Arbitrary<ArtifactPaths> = fc.record({
  briefPath: fc.option(fc.constant("brief.json"), { nil: null }),
  storyboardPath: fc.option(fc.constant("storyboard.json"), { nil: null }),
  compositionDir: fc.option(fc.constant("composition"), { nil: null }),
  indexHtmlPath: fc.option(fc.constant("composition/index.html"), {
    nil: null,
  }),
  hyperframesJsonPath: fc.option(fc.constant("composition/hyperframes.json"), {
    nil: null,
  }),
  audioPaths: fc.array(
    fc
      .integer({ min: 1, max: MAX_SCENES })
      .map((i) => `assets/scene-${i}.mp3`),
    { maxLength: MAX_SCENES },
  ),
  videoPath: fc.option(
    fc.integer({ min: 1, max: 100 }).map((n) => `/videos/project-${n}.mp4`),
    { nil: null },
  ),
});

const templateSourceArb: fc.Arbitrary<TemplateSource> = fc.record({
  name: fc.constant("hf-blank"),
  version: fc.constantFrom("0.5.5", "1.0.0", "unknown", "abc1234"),
  sourcePath: fc.constantFrom(
    "/tmp/hf-blank",
    "/Users/dev/hf-blank",
    "/opt/templates/hf-blank",
  ),
});

// ---------------------------------------------------------------------------
// Project arb — full fidelity, round-trips through ProjectSchema
// ---------------------------------------------------------------------------

export const projectArb: fc.Arbitrary<Project> = fc
  .record({
    schemaVersion: fc.constant(1 as const),
    projectId: projectIdArb,
    title: safeString({ minLength: 1, maxLength: LIMITS.TITLE_MAX }),
    topic: safeString({ minLength: 1, maxLength: LIMITS.TOPIC_MAX }),
    locale: fc.constantFrom<"zh-CN" | "en-US">("zh-CN", "en-US"),
    stage: stageArb,
    stageStatus: stageStatusMapArb,
    stageHistory: fc.array(stageHistoryEntryArb, { maxLength: 10 }),
    brief: fc.option(briefArb, { nil: null }),
    storyboard: fc.option(storyboardArb, { nil: null }),
    artifacts: artifactPathsArb,
    qaNotes: fc.array(qaNoteArb, { maxLength: 10 }),
    templateSource: templateSourceArb,
    createdAt: isoDateArb,
    updatedAt: isoDateArb,
  });
