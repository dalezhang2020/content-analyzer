# Implementation Plan: Video Creation Workbench

## Overview

Incremental build order: pure modules → I/O services → Route Handlers → UI → E2E smoke. Every task references the Requirement IDs and design Properties it satisfies. Property-based tests (`fast-check`) live next to the module they validate; integration tests for services use mocked externals. Live smoke is gated behind `WORKBENCH_LIVE=1`.

All paths are relative to `content-analyzer/web/`. TypeScript is the implementation language (matches existing Next.js 16 / React 19 / vitest stack).

## Tasks

### Phase 0 — Project setup

- [x] T01 Add runtime + test dependencies
  - Add `zod` to `dependencies` and `fast-check`, `msw` to `devDependencies` in `package.json`
  - Run `npm install` and commit `package-lock.json`
  - Files: `package.json`, `package-lock.json`
  - _Requirements: 16.1 (zod validation), 14.1 (unified error schema); design §Testing Strategy_
  - Acceptance: `npm install` succeeds; `import { z } from "zod"` and `import fc from "fast-check"` both resolve from TS

- [x] T02 Extend `.gitignore` for workbench artifacts
  - Append rules for `data/projects/**`, `public/videos/project-*.mp4`, `public/videos/project-*.prev.mp4`, `public/videos/project-*.poster.jpg`
  - Files: `.gitignore`
  - _Requirements: 8.11_
  - Acceptance: `git status` after touching `data/projects/foo.json` shows no new tracked file

- [x] T03 Wire fast-check seed and shared test utilities
  - Extend `src/test/setup.ts` to call `fc.configureGlobal({ seed: 0xBEEF, numRuns: 100 })`
  - Add `src/test/fixtures/tmp-dir.ts` (creates unique `os.tmpdir()` dir, auto-cleanup on `afterEach`)
  - Add `src/test/fixtures/project-builder.ts` (fast-check arbitraries for `Project`, `Scene`, `StageStatusMap`)
  - Add `src/test/fixtures/msw-server.ts` (MSW node server with `beforeAll/afterEach/afterAll` hooks, empty handler set)
  - Files: `src/test/setup.ts`, `src/test/fixtures/*.ts`
  - _Requirements: — (tooling); design §Property-based Test Configuration_
  - Acceptance: running `npm test` with a no-op `fc.assert` works; tmp-dir helper cleans up after test

### Phase 1 — Pure core modules

- [x] T04 Define core TypeScript types
  - Create `src/lib/workbench/types.ts` with `Stage`, `StageStatusValue`, `StageStatus`, `StageStatusMap`, `StageHistoryEntry`, `ArtifactPaths`, `TemplateSource`, `QaNote`, `Brief`, `Scene`, `Voice`, `Storyboard`, `Project`, `ProjectSummary`, `CreateProjectInput`, `DeleteReport`, `TTSBatchResult`, `RenderEvent`, `ErrorResponse`
  - All fields typed exactly as documented in design §Data Models
  - Files: `src/lib/workbench/types.ts`
  - _Requirements: 2.2, 2.11, 3.1; design §Data Models_
  - Acceptance: `tsc --noEmit` passes; types re-exportable from `@/lib/workbench/types`

- [x] T05 Define constants
  - Create `src/lib/workbench/constants.ts` exporting `STAGES` (8-tuple in order), `STAGE_ORDER` (Record<Stage, number> 0..7), `VOICES` (curated Azure voice list), `DEFAULT_VOICE` (`"zh-CN-Xiaochen:DragonHDFlashLatestNeural"`), `SCHEMA_VERSION = 1`, `LIMITS` (title/narration/qaNote/corePoints etc.), `TIMEOUTS_MS` (LLM 60s/90s, TTS 60s, lint 30s, validate 30s, render 180s, stage 3600s, api 120s), `REGEX` (`PROJECT_ID`, `SCENE_ID`, `QA_NOTE_ID`), `STAGE_DIRS` (`composition/`, `assets/`, `fonts/`, `logs/`), `AZURE_TTS_OUTPUT_FORMAT`, `LLM_TIMEOUT_MS` per task, `MAX_SCENES = 20`, `MIN_SCENES = 3`, `DATA_DIR = "data/projects"`, `VIDEO_DIR = "public/videos"`
  - Files: `src/lib/workbench/constants.ts`
  - _Requirements: 1.1, 2.11, 3.2, 3.6, 5.3, 9.5, 14.6, 16.1_
  - Acceptance: `STAGES` matches Stage union; constants importable

- [x] T06 Implement `errors.ts`
  - [x] T06.1 Implement `ErrorCode` enum and `WorkbenchError` class
    - Create `src/lib/workbench/errors.ts` mirroring the enum in design §Error Handling
    - `WorkbenchError` constructor truncates `message` to 500 chars with `…` suffix
    - `toResponse()` returns `{ error: { code, message, details? } }`
    - Add `respondWithError(e: unknown): Response` that maps `WorkbenchError`, `ZodError`, and unknown errors to the HTTP-status matrix; unknown → 500 `UNKNOWN` with message `"Internal error"` (no stack leak)
    - Files: `src/lib/workbench/errors.ts`
    - _Requirements: 14.1, 14.7; Property 24_
  - [x]* T06.2 Write property test for error serialisation
    - **Property 24: Every WorkbenchError serialises to the unified error schema**
    - **Validates: Requirements 14.1, 14.7**
    - Files: `src/lib/workbench/errors.test.ts`

- [x] T07 Implement `path-safety.ts`
  - [x] T07.1 Implement regex validators and path guard
    - Create `src/lib/workbench/path-safety.ts` exporting `isValidProjectId(s)`, `isValidSceneId(s)`, `assertUnderDataDir(abs)`, `resolveProjectFile(projectId, ...parts)`, `scrubControlChars(s)` (throws `CONTROL_CHAR_REJECTED`), `hasPathTraversal(s)` (checks `..`, absolute prefix, NUL)
    - `resolveProjectFile` calls `path.resolve(DATA_DIR, projectId, ...)` then asserts result starts with `path.resolve(DATA_DIR) + path.sep`
    - Files: `src/lib/workbench/path-safety.ts`
    - _Requirements: 2.3, 3.2, 8.7, 8.8, 16.3, 16.4, 16.6; Properties 11, 12_
  - [x]* T07.2 Write property test for path safety
    - **Property 11: Path safety forbids traversal and honours id regex**
    - **Validates: Requirements 2.3, 3.2, 8.7, 8.8, 16.4, 16.6**
    - Files: `src/lib/workbench/path-safety.test.ts`
  - [x]* T07.3 Write property test for control-char scrubber
    - **Property 12: Control-character scrubber accepts iff input is clean**
    - **Validates: Requirements 16.3**
    - Files: `src/lib/workbench/path-safety.test.ts` (same file)

- [x] T08 Implement `schemas.ts` (zod)
  - [x] T08.1 Author zod schemas mirroring `types.ts`
    - Create `src/lib/workbench/schemas.ts` exporting `StageSchema`, `StageStatusSchema`, `StageStatusMapSchema`, `StageHistoryEntrySchema`, `BriefSchema`, `SceneSchema`, `StoryboardSchema`, `ArtifactPathsSchema`, `TemplateSourceSchema`, `QaNoteSchema`, `ProjectSchema`, `CreateProjectInputSchema`, `SceneEditableSchema`, `SceneRewriteSchema`, `StoryboardOutputSchema`, `ErrorResponseSchema`
    - Apply 4000/20000 char limits per field per Req 16.1; `refine` to reject control chars via `scrubControlChars`
    - Files: `src/lib/workbench/schemas.ts`
    - _Requirements: 2.2, 2.11, 3.1, 3.4, 3.5, 3.6, 3.7, 16.1; Property 5_
  - [x]* T08.2 Write property test for schema round-trip
    - **Property 5: Project and Scene schema round-trip**
    - **Validates: Requirements 1.7, 2.2, 2.11, 2.12, 3.1, 3.2, 3.4, 3.5, 3.6, 3.7**
    - Files: `src/lib/workbench/schemas.test.ts`

- [x] T09 Implement `state-machine.ts`
  - [x] T09.1 Implement transitions, guards, and stage status lifecycle helpers
    - Create `src/lib/workbench/state-machine.ts` exporting `FORWARD_TRANSITIONS`, `BACKWARD_TRANSITIONS`, `canTransition(from, to)`, `allowedNextStages(from)`, `assertCanTransition(from, to)` (throws `INVALID_TRANSITION`), `resetDownstreamStatus(map, target)`, `applyTransition(project, to, reason?, result?)`, `markStageRunning(project, stage, now)`, `markStageSucceeded(project, stage, now)`, `markStageFailed(project, stage, now, error)`, `shouldSuggestRegress(history, stage)`, `initialStageStatusMap()`
    - `markStageFailed` stores `error.code` (≤64 chars) and truncates `error.message` to 500 chars per Req 14.7
    - Files: `src/lib/workbench/state-machine.ts`
    - _Requirements: 1.1–1.10, 14.7, 14.8; Properties 1, 2, 3, 4, 26_
  - [x]* T09.2 Write property test for transition well-formedness
    - **Property 1: State transition table is well-formed**
    - **Validates: Requirements 1.3, 1.5**
    - Files: `src/lib/workbench/state-machine.test.ts`
  - [x]* T09.3 Write property test for regression reset
    - **Property 2: Regression resets downstream stages only**
    - **Validates: Requirements 1.4**
    - Files: `src/lib/workbench/state-machine.test.ts`
  - [x]* T09.4 Write property test for atomic transition
    - **Property 3: Stage transition is atomic**
    - **Validates: Requirements 1.6**
    - Files: `src/lib/workbench/state-machine.test.ts`
  - [x]* T09.5 Write property test for per-stage status lifecycle
    - **Property 4: Per-stage status lifecycle preserves stage and orders timestamps**
    - **Validates: Requirements 1.8, 1.9, 1.10**
    - Files: `src/lib/workbench/state-machine.test.ts`
  - [x]* T09.6 Write property test for 3-consecutive-failure hint
    - **Property 26: Three-consecutive-failures hint trigger**
    - **Validates: Requirements 14.8**
    - Files: `src/lib/workbench/state-machine.test.ts`

- [x] T10 Implement `scene-reindexer.ts`
  - [x] T10.1 Implement pure reindex operations
    - Create `src/lib/workbench/scene-reindexer.ts` exporting `reindex(scenes)`, `insertScene(scenes, at, newScene)`, `deleteScene(scenes, sceneId)`, `moveScene(scenes, from, to)`, `applySceneEdit(scene, patch)`, `remapAudioPath(scene, newIndex)`
    - After any mutation, indexes are `[1..N]`, `audioPath` non-null entries are rewritten to `assets/scene-{newIndex}.mp3`
    - `applySceneEdit` clears `audioPath` iff `narration` or `voice` changed (Property 10)
    - Files: `src/lib/workbench/scene-reindexer.ts`
    - _Requirements: 3.3, 3.8, 3.9, 5.7, 5.9; Properties 9, 10_
  - [x]* T10.2 Write property test for reindex invariants
    - **Property 9: Scene re-indexing preserves [1..N] under any edit sequence**
    - **Validates: Requirements 3.3, 3.9, 5.7, 5.9**
    - Files: `src/lib/workbench/scene-reindexer.test.ts` (uses `fc.commands` for command sequence)
  - [x]* T10.3 Write property test for audio invalidation
    - **Property 10: Editing narration or voice invalidates cached audio**
    - **Validates: Requirements 3.8**
    - Files: `src/lib/workbench/scene-reindexer.test.ts`

- [x] T11 Implement `html-scanner.ts`
  - [x] T11.1 Implement case-insensitive forbidden-token scanner
    - Create `src/lib/workbench/html-scanner.ts` exporting `scanHtml(h): { ok: true } | { ok: false; hit: string }` checking for `<iframe`, `<object`, `<embed`, `fetch(`, `XMLHttpRequest`, `Date.now(`, `Math.random(`
    - Pure, no HTML parser; no input mutation
    - Files: `src/lib/workbench/html-scanner.ts`
    - _Requirements: 6.3, 16.7; Property 13_
  - [x]* T11.2 Write property test for danger scanner
    - **Property 13: HTML danger scanner rejects iff forbidden tokens are present**
    - **Validates: Requirements 6.3, 16.7**
    - Files: `src/lib/workbench/html-scanner.test.ts`

- [x] T12 Implement `audio-injector.ts`
  - [x] T12.1 Implement pure HTML `<audio>` injection
    - Create `src/lib/workbench/audio-injector.ts` exporting `injectAudio(html, storyboard, successfulIndexes): string`
    - For each `i ∈ successfulIndexes`, ensure exactly one `<audio data-start=... data-duration=... src="assets/scene-{i}.mp3">` inside that scene's container; drop/replace any existing tag for that scene
    - Scenes outside the successful set must have no `<audio>` injected
    - Files: `src/lib/workbench/audio-injector.ts`
    - _Requirements: 9.10, 9.11, 9.12; Property 14_
  - [x]* T12.2 Write property test for injection bijection + reversibility
    - **Property 14: Audio injection inserts exactly the successful scenes and is perfectly reversible**
    - **Validates: Requirements 9.10, 9.11, 9.12**
    - Files: `src/lib/workbench/audio-injector.test.ts`

- [x] T13 Implement `logger.ts`
  - [x] T13.1 Implement JSON-line logger with rotation and redaction
    - Create `src/lib/workbench/logger.ts` exporting `createLogger(projectId, stage): { info(event, data?), warn(event, data?), error(event, data?), timed<T>(event, fn): Promise<T> }`
    - Writes one JSON object per line to `data/projects/{projectId}/logs/{stage}.log` with `ts`, `level`, `stage`, `event`, `durationMs?`, plus user fields
    - On write: if file size > 10 MB, rotate `{stage}.log → .log.1`, shift `.1 → .2 → .3`, delete `.4+`
    - Redaction pass: scan string values for any env-var value whose length ≥ 16 and mask as `***REDACTED***`
    - `timed` records `durationMs` integer
    - Files: `src/lib/workbench/logger.ts`
    - _Requirements: 9.9, 14.2, 14.3, 14.9; Property 25_
  - [x]* T13.2 Write property test for rotation bounds
    - **Property 25: Log rotation bounds file count and size**
    - **Validates: Requirements 14.3**
    - Files: `src/lib/workbench/logger.test.ts` (uses tmp-dir helper)

- [x] T14 Implement `time-format.ts` (relative time)
  - [x] T14.1 Implement `formatRelativeTime(now, then): string`
    - Create `src/lib/workbench/time-format.ts`
    - Buckets: `<60s → "刚刚"`, `<3600s → "N 分钟前"`, `<86400s → "N 小时前"`, `<30d → "N 天前"`, else `YYYY-MM-DD`
    - Files: `src/lib/workbench/time-format.ts`
    - _Requirements: 11.1; Property 23_
  - [x]* T14.2 Write property test for time buckets
    - **Property 23: Relative-time formatter falls in the documented buckets**
    - **Validates: Requirements 11.1**
    - Files: `src/lib/workbench/time-format.test.ts`

- [x] T15 Implement `tab-gating.ts` (UI helper)
  - [x] T15.1 Implement `canEnterTab(tab, stage): boolean`
    - Create `src/lib/workbench/tab-gating.ts` using `STAGE_ORDER` from constants; map Brief≥brief, Storyboard≥storyboard, HTML≥composition, Audio≥composition, Render≥audio, QA≥render
    - Files: `src/lib/workbench/tab-gating.ts`
    - _Requirements: 12.11; Property 22_
  - [x]* T15.2 Write property test for tab gating
    - **Property 22: Tab gating matches the stage-to-tab map**
    - **Validates: Requirements 12.11**
    - Files: `src/lib/workbench/tab-gating.test.ts`

- [x] T16 Implement `scene-rewrite-rules.ts`
  - [x] T16.1 Implement `validateSceneRewrite(d, d', qaNote)` and `compositionRegenRequired(T, T')`
    - Create `src/lib/workbench/scene-rewrite-rules.ts`
    - `validateSceneRewrite`: accept if qaNote (case-insensitive) contains any of `改时长 / change duration / 缩短 / 加长 / shorten / lengthen`, else accept iff `|d' - d| / d ≤ 0.3`
    - `compositionRegenRequired`: `|T' - T| / T > 0.10`
    - Files: `src/lib/workbench/scene-rewrite-rules.ts`
    - _Requirements: 7.3, 7.5; Properties 19, 20_
  - [x]* T16.2 Write property tests for rewrite rules
    - **Property 19: Scene-rewrite duration acceptance bounds** — _Validates: Requirements 7.3_
    - **Property 20: compositionRegenRequired flag tracks total-duration drift** — _Validates: Requirements 7.5_
    - Files: `src/lib/workbench/scene-rewrite-rules.test.ts`

- [x] T17 Checkpoint — Pure core modules green
  - Ensure all tests pass, ask the user if questions arise.

### Phase 2 — I/O services (mocked externals)

- [x] T18 Implement `locks.ts`
  - [x] T18.1 Implement per-project in-memory mutex
    - Create `src/lib/workbench/locks.ts` exporting `withProjectLock<T>(projectId, fn): Promise<T>` with a `Map<string, Promise<unknown>>`; lock busy throws `LOCK_BUSY`
    - Different projectIds never block each other
    - Files: `src/lib/workbench/locks.ts`
    - _Requirements: 1.11, 10.3; Property 21_
  - [x]* T18.2 Write property test for mutual exclusion (fc.scheduler)
    - **Property 21: Per-project lock is mutually exclusive**
    - **Validates: Requirements 1.11, 10.3**
    - Files: `src/lib/workbench/locks.test.ts`

- [x] T19 Implement `atomic-fs.ts` (helper used by store/tts/render)
  - [x] T19.1 Implement atomic write helper
    - Create `src/lib/workbench/atomic-fs.ts` exporting `atomicWriteJson(absPath, obj)`, `atomicWriteBuffer(absPath, buf)`, `atomicCopyFile(src, dst)`, `ensureDir(abs)`, `removeTree(abs)`
    - Semantics: write `{target}.tmp` → `fsync` → `rename`; on any error clean up `.tmp`
    - Files: `src/lib/workbench/atomic-fs.ts`
    - _Requirements: 2.7, 2.8, 4.5, 7.4, 8.9, 9.4, 9.7; Property 7_
  - [x]* T19.2 Write property test for atomic write coherence
    - **Property 7: Atomic writer — coherent reads and no residue on failure**
    - **Validates: Requirements 2.7, 2.8, 4.5, 7.4, 8.9, 9.4, 9.7**
    - Uses tmp dir + inject fs failures via monkey-patched `fs.rename`
    - Files: `src/lib/workbench/atomic-fs.test.ts`

- [x] T20 Implement `project-store.ts`
  - [x] T20.1 Implement Store CRUD + atomic persistence
    - Create `src/lib/workbench/project-store.ts` exporting `generateProjectId()`, `createProject(input, templateSource)`, `readProject(projectId)`, `writeProject(p)`, `deleteProject(projectId)`, `listProjects()`, `writeBrief(projectId, brief)`, `writeStoryboard(projectId, sb)`, `writeCompositionHtml(projectId, html)`, `writeAudioFile(projectId, index, buf)`, `initProjectDirs(projectId)`
    - `generateProjectId` retries up to 5 on collision (Req 2.3)
    - `writeProject` uses `atomicWriteJson`, updates `updatedAt` monotonically (Req 2.5)
    - `readProject` validates with `ProjectSchema`; rejects `schemaVersion !== 1` with `SCHEMA_VERSION_MISMATCH`; rejects missing file with `PROJECT_NOT_FOUND`; parse failure → `READ_FAILED` with file path
    - `deleteProject` removes `data/projects/{id}.json`, the dir, and `public/videos/project-{id}.mp4`; returns `DeleteReport { succeeded[], failed[] }`
    - `listProjects` returns lightweight `ProjectSummary[]` (title, stage, updatedAt, posterExists, videoPathIfAny)
    - `initProjectDirs` creates `composition/`, `composition/assets/.gitkeep`, `composition/fonts/.gitkeep`, `logs/`
    - All write paths pass `assertUnderDataDir`
    - Files: `src/lib/workbench/project-store.ts`
    - _Requirements: 2.1–2.12, 8.1, 8.6, 8.7, 8.8, 8.9, 8.10_
  - [x]* T20.2 Write integration tests for store round-trip
    - Covers `writeProject → readProject` round-trip, rejection of malformed JSON, delete report partial failure
    - _Validates: Requirements 2.9, 2.10_
    - Files: `src/lib/workbench/project-store.test.ts`
  - [x]* T20.3 Write property test for updatedAt monotonicity
    - **Property 6: updatedAt is monotonic across any mutation sequence**
    - **Validates: Requirements 2.5**
    - Files: `src/lib/workbench/project-store.test.ts`
  - [x]* T20.4 Write property test for malformed JSON rejection
    - **Property 8: Malformed project JSON is rejected, never silently repaired**
    - **Validates: Requirements 2.9, 2.10**
    - Files: `src/lib/workbench/project-store.test.ts`

- [x] T21 Implement `template-manager.ts`
  - [x] T21.1 Implement resolver, deep-copy, and sync-template merge
    - Create `src/lib/workbench/template-manager.ts` exporting `resolveTemplateDir()`, `selectFilesToCopy(listing)`, `deepCopyTemplate(src, dst)`, `readTemplateVersion(src)`, `syncTemplate(src, dst, baseline)`
    - `resolveTemplateDir` tries `process.env.HYPERFRAMES_TEMPLATE_DIR`, `../linear-launch`, `../../linear-launch` in order; returns first with readable `hyperframes.json`; else throws `TEMPLATE_NOT_FOUND` with `details.tried`
    - `selectFilesToCopy` excludes `captures/`, `.thumbnails/`, `*.mp4` (Property 16)
    - `deepCopyTemplate` copies directory tree using `atomicCopyFile`, preserves mode bits; on failure cleans up destination (Req 15.5)
    - `readTemplateVersion`: template `package.json.version` → git rev-parse HEAD → `"unknown"`
    - `syncTemplate`: merge `hyperframes.json`/`package.json`/`fonts/` only; abort with `TEMPLATE_CONFLICT` when `hyperframes.json` diverges from baseline; never touch `index.html` or `assets/`
    - Files: `src/lib/workbench/template-manager.ts`
    - _Requirements: 8.2, 8.5, 15.1–15.8_
  - [x]* T21.2 Write property test for resolver
    - **Property 15: Template resolver picks the first existing candidate**
    - **Validates: Requirements 8.5, 15.1, 15.2**
    - Files: `src/lib/workbench/template-manager.test.ts`
  - [x]* T21.3 Write property test for exclusion filter
    - **Property 16: Deep-copy exclusion is idempotent and excludes the forbidden set**
    - **Validates: Requirements 15.3, 15.4**
    - Files: `src/lib/workbench/template-manager.test.ts`
  - [x]* T21.4 Write property test for sync-template merge preservation
    - **Property 17: sync-template merge preserves local work**
    - **Validates: Requirements 15.6, 15.7**
    - Files: `src/lib/workbench/template-manager.test.ts`

- [x] T22 Implement `ai-generator.ts` (LLM tasks)
  - [x] T22.1 Implement `callLLM` helper + four tasks
    - Create `src/lib/workbench/ai-generator.ts`
    - Env: reads `KIRO_CLI_BIN` (default `"kiro-cli"`) + `KIRO_MODEL` (default `"claude-sonnet-4.6"`); no API keys required — the CLI reuses the host's existing Kiro authentication
    - `callLLM(messages, { timeoutMs, maxOutputTokens })` spawns `kiro-cli chat --no-interactive --trust-all-tools --model {KIRO_MODEL}` with `AbortController` timeout → throws `LLM_TIMEOUT`; logs `durationMs` via `logger.timed`; strips ANSI codes + `▸ Credits:` footer from stdout
    - `generateBrief(project)`: up to 3 attempts, each parses with `BriefSchema`; on final failure throws `LLM_OUTPUT_INVALID` with `details.snippet` (≤500 chars)
    - `generateStoryboard(project)`: 1 tolerance-retry when total-duration outside ±15%, else one schema-retry; returns `{ scenes, warning? }`
    - `generateComposition(project)`: 1 repair-retry driven by lint/validate stderr; returns raw HTML string; caller runs `scanHtml` before write
    - `rewriteScene(project, scene, qaNote)`: no retry on schema fail (per Req 7.7); returns `{ narration, durationSec? }`
    - Each task runs behind `TIMEOUTS_MS`, writes log entries, never logs prompts or subprocess env
    - Files: `src/lib/workbench/ai-generator.ts`
    - _Requirements: 4.1–4.9, 5.1–5.7, 6.1–6.4, 7.1–7.3, 7.7, 14.6, 14.9_
  - [x]* T22.2 Write property test for retry budget
    - **Property 18: LLM retry respects the configured attempt budget**
    - **Validates: Requirements 4.3, 4.4, 5.5, 5.6, 7.7**
    - Uses mock `callLLM` with scripted outputs
    - Files: `src/lib/workbench/ai-generator.test.ts`
  - [x]* T22.3 Write integration tests with MSW for each task happy path
    - Covers BriefSchema/StoryboardOutputSchema parsing, tolerance-retry trigger, timeout propagation
    - _Validates: Requirements 4.1, 4.2, 4.7, 5.1, 5.3, 5.4, 6.1, 7.1_
    - Files: `src/lib/workbench/ai-generator.test.ts`

- [x] T23 Implement `tts-service.ts`
  - [x] T23.1 Implement Azure Speech TTS per-scene + batch synthesize
    - Create `src/lib/workbench/tts-service.ts` exporting `synthesizeAll(project, { force? })`, `synthesizeOne(project, sceneId)`
    - Per scene: skip if `audioPath` non-null && mp3 exists && !force; else POST SSML body to `{AZURE_SPEECH_ENDPOINT}/cognitiveservices/v1` with `Ocp-Apim-Subscription-Key` header and `X-Microsoft-OutputFormat: AZURE_TTS_OUTPUT_FORMAT`; retries at `1s, 3s` back-off (max 3 attempts), per-call timeout 60 s; `voice` falls back to `DEFAULT_VOICE` when missing/unknown
    - Write mp3 to `composition/assets/scene-{index}.mp3` via `atomicWriteBuffer`; update scene `audioPath`
    - Return `TTSBatchResult` with failures list; caller decides 200 vs 207 status
    - `AZURE_SPEECH_ENDPOINT` or `AZURE_SPEECH_KEY` missing/empty → throw `TTS_PROVIDER_UNCONFIGURED` before any external call
    - Never log subscription key value
    - Files: `src/lib/workbench/tts-service.ts`
    - _Requirements: 9.1–9.9_
  - [x]* T23.2 Write integration test for TTS with MSW
    - Happy path, retry on 5xx, fallback voice, key-missing short-circuit, 207 summary on partial failure
    - _Validates: Requirements 9.3, 9.5, 9.6, 9.8, 9.9_
    - Files: `src/lib/workbench/tts-service.test.ts`

- [x] T24 Implement `render-service.ts`
  - [x] T24.1 Implement HyperFrames subprocess + SSE event iterator
    - Create `src/lib/workbench/render-service.ts` exporting `startRender(project): { runId, stream: AsyncIterable<RenderEvent> }`, `getActiveRender(projectId)`, `killRender(projectId)`
    - Rename existing `public/videos/project-{id}.mp4 → .prev.mp4` before spawn; rename failure → `PREV_RENAME_FAILED`
    - Spawn `npx hyperframes render --output {abs} --fps 30` in `composition/` dir
    - Stream stdout/stderr lines (truncated ≤500 chars) as `{ type: "line" }` events and into `data/projects/{id}/render.log` (buffered flush ≤2 s)
    - Emit `{ type: "stage", stage: "starting" | "rendering" | "encoding" | "done" | "failed" }` based on stdout regex + exit
    - Emit `heartbeat` every 2 s when no new line
    - Enforce 180 s wall-clock; on timeout → kill process, cleanup partial mp4, emit `stage: failed`, map to `RENDER_TIMEOUT`
    - On exit 0 + file exists && size>0 → emit `stage: done`; on exit 0 + missing/0-byte → `stage: failed` (500); on non-zero exit → capture stderr tail 500 chars, `stage: failed` (500)
    - Files: `src/lib/workbench/render-service.ts`
    - _Requirements: 10.1, 10.4–10.11_
  - [x]* T24.2 Write integration test with mocked spawn
    - Covers happy path, timeout, exit!=0, zero-byte mp4; verifies SSE event ordering and render.log contents
    - _Validates: Requirements 10.5, 10.6, 10.8, 10.9, 10.10_
    - Files: `src/lib/workbench/render-service.test.ts`

- [x] T25 Checkpoint — Services green with mocks
  - Ensure all tests pass, ask the user if questions arise.

### Phase 3 — Route Handlers

- [x] T26 Implement request-pipeline helpers
  - Create `src/lib/workbench/api-helpers.ts` with `parseJsonBody(req, { maxBytes })` (enforces 1 MB / 4 MB per Req 16.5 → throws `PAYLOAD_TOO_LARGE`), `parseWithSchema(schema, data)` (maps `ZodError` → `VALIDATION_FAILED` 400 with `details`), `requireProjectId(ctx)`, `requireSceneId(ctx)`, `respondJson(body, status)`, `respondError(e)` (delegates to `respondWithError`)
  - Files: `src/lib/workbench/api-helpers.ts`
  - _Requirements: 14.1, 16.1, 16.2, 16.4, 16.5_
  - Acceptance: helpers cover all 21 endpoints' pre-checks

- [x] T27 Implement `POST /api/projects` and `GET /api/projects`
  - Create `src/app/api/projects/route.ts` with `POST` (validate `CreateProjectInputSchema`, resolve template, `createProject`, return 201 Project) and `GET` (return `listProjects` sorted by `updatedAt` desc)
  - On template copy failure: roll back project dir (Req 15.5, 8.9)
  - Files: `src/app/api/projects/route.ts`
  - _Requirements: 2.1–2.4, 2.7, 8.1–8.5, 8.9, 11.1_
  - Acceptance: creating a project persists JSON + template copy + initial `stageStatus`; listing returns summaries

- [x] T28 Implement `GET/PATCH/DELETE /api/projects/[id]`
  - Create `src/app/api/projects/[id]/route.ts`
  - `GET`: `readProject` → 200 Project; 404 / 400 / 409 per matrix
  - `PATCH`: accept `{ title?, topic? }`; reject `topic` change when `stage !== "topic"` (409 `INVALID_STAGE`); update with `withProjectLock`
  - `DELETE`: call `deleteProject`; if `failed[]` non-empty → 500 `PARTIAL_DELETE` with details
  - Files: `src/app/api/projects/[id]/route.ts`
  - _Requirements: 2.9, 2.10, 2.12, 8.6, 8.10, 11.8_

- [x] T29 Implement `POST /api/projects/[id]/brief/generate`
  - Create `src/app/api/projects/[id]/brief/generate/route.ts`
  - Flow: lock → stage guard (`topic` or `force`) → `markStageRunning("brief")` → `generateBrief` → `writeBrief` → `applyTransition(topic→brief)` → `writeProject`
  - `force: true` allowed after brief exists; stage !== topic && !force → 409; topic empty/out of range → 422
  - On LLM failure: `markStageFailed`, keep stage=topic, return 502 with `details.lastSnippet`
  - Files: `src/app/api/projects/[id]/brief/generate/route.ts`
  - _Requirements: 4.1–4.9_

- [x] T30 Implement `POST /api/projects/[id]/storyboard/generate`
  - Create `src/app/api/projects/[id]/storyboard/generate/route.ts`
  - Flow: lock → require stage=`brief` (else 409) → `generateStoryboard` → assign `sceneId`/`index` → `writeStoryboard` → advance to `storyboard`
  - Pass through `warning` from tolerance-retry to response body
  - Files: `src/app/api/projects/[id]/storyboard/generate/route.ts`
  - _Requirements: 5.1–5.7_

- [x] T31 Implement `POST /api/projects/[id]/composition/generate` and `.../composition/sync-template`
  - Create `src/app/api/projects/[id]/composition/generate/route.ts` and `src/app/api/projects/[id]/composition/sync-template/route.ts`
  - `generate`: lock → stage=`storyboard` → `generateComposition` → `scanHtml` → write `composition/index.html` → spawn `hyperframes lint` + `validate` (30s each) → on failure, one repair-retry; final failure preserves `index.failed.html`, status 502
  - `sync-template`: call `syncTemplate` with baseline from `templateSource`; on conflict → 409
  - Files: two `route.ts`
  - _Requirements: 6.1–6.8, 15.6, 15.7, 16.7_

- [x] T32 Implement `POST /api/projects/[id]/audio/generate`
  - Create `src/app/api/projects/[id]/audio/generate/route.ts`
  - Flow: lock → stage=`composition` → `synthesizeAll` → backup `index.html → index.prev.html` → `injectAudio` for successful subset → rewrite `index.html` via `atomicWriteJson`-ish helper → run lint+validate
  - On post-inject lint/validate fail: restore `.prev.html`, stage regress to `composition`, 500 `AUDIO_INJECT_ROLLBACK`
  - Full success → advance to `audio`, 200; partial → keep stage=`composition`, 207 with failures
  - Key missing → 500 `TTS_PROVIDER_UNCONFIGURED`
  - Files: `src/app/api/projects/[id]/audio/generate/route.ts`
  - _Requirements: 9.1–9.12_

- [x] T33 Implement `POST /api/projects/[id]/render` + `GET .../render/stream`
  - Create `src/app/api/projects/[id]/render/route.ts` and `src/app/api/projects/[id]/render/stream/route.ts`
  - `POST /render`: stage=`audio` else 409; already running → 409 `RENDER_IN_PROGRESS`; call `render-service.startRender` → respond 202 with `{ runId, streamUrl: "/api/projects/{id}/render/stream" }`
  - `GET /render/stream`: Next.js streaming response (`ReadableStream` with `TextEncoder`); set `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `Content-Type: text/event-stream`; proxy events from the active render iterator; terminal event closes stream; no active render → 409 `NO_RENDER`
  - On exit success → `writeProject` with `artifacts.videoPath = "/videos/project-{id}.mp4"`, advance to `render`
  - Files: two `route.ts`
  - _Requirements: 10.1–10.11_

- [x] T34 Implement `POST /api/projects/[id]/publish`
  - Create `src/app/api/projects/[id]/publish/route.ts`
  - Require stage ∈ `{render, qa}` AND `artifacts.videoPath` resolves to an existing mp4 with size > 0; else 409 `CANNOT_PUBLISH` with `details.missing[]`
  - Advance stage to `published` via `applyTransition`
  - Files: `src/app/api/projects/[id]/publish/route.ts`
  - _Requirements: 17.5, 17.6_

- [x] T35 Implement scene CRUD routes
  - Create:
    - `src/app/api/projects/[id]/scenes/route.ts` (`POST`: create scene, validate, reindex, enforce `[3,20]` and stage∈`{storyboard,composition,audio,render,qa}`)
    - `src/app/api/projects/[id]/scenes/[sceneId]/route.ts` (`PATCH`: update editable fields, apply `applySceneEdit`; `DELETE`: remove + reindex + delete associated mp3)
  - Enforce `SceneEditableSchema` (title/narration/durationSec/voice/qaNote), clear `audioPath` on narration/voice change (delegated to `applySceneEdit`)
  - Files: two `route.ts`
  - _Requirements: 3.1, 3.3–3.9, 5.8–5.10_

- [x] T36 Implement scene TTS and rewrite routes
  - Create:
    - `src/app/api/projects/[id]/scenes/[sceneId]/tts/route.ts` (`POST`: call `synthesizeOne`)
    - `src/app/api/projects/[id]/scenes/[sceneId]/rewrite/route.ts` (`POST`: validate `qaNote` 1–500 chars, call `rewriteScene`, apply `validateSceneRewrite` guard, on accept atomically update narration/durationSec/qaNote/clear audioPath/regress to `storyboard`; compute `compositionRegenRequired` via `Property 20` helper)
  - Files: two `route.ts`
  - _Requirements: 7.1–7.7, 9.1_

- [x] T37 Implement QA notes routes
  - Create `src/app/api/projects/[id]/qa-notes/route.ts`
  - `POST`: accept `{ sceneId?: string|null, text: string ≤2000 }`, append `QaNote` with generated `noteId` (`qan_{8hex}`), `author: "local"`, `createdAt`
  - `GET`: return `qaNotes` array
  - Files: `src/app/api/projects/[id]/qa-notes/route.ts`
  - _Requirements: 12.10_

- [x] T38 Checkpoint — All 21 endpoints respond per contract
  - Ensure all tests pass, ask the user if questions arise.

### Phase 4 — Shared UI components

- [x] T39 Implement `StagePanel` and `StageBadge`
  - Create `src/components/workbench/stage-panel.tsx`, `src/components/workbench/stage-badge.tsx`
  - Render 8 stages vertically with badge (`pending` gray, `running` blue with spinner, `succeeded` green check, `failed` red, `skipped` amber); highlight current stage
  - Each stage row links to the relevant Tab (callback prop)
  - Files: two `.tsx`
  - _Requirements: 12.1, 14.7_

- [x] T40 Implement `SceneDrawer` with diff view
  - Create `src/components/workbench/scene-drawer.tsx` and `src/components/workbench/diff-view.tsx`
  - Drawer slides from right; edit `title/narration/durationSec/voice/qaNote` with field-level validation (reuse zod schemas via `safeParse`)
  - Three buttons: `保存`、`重新生成 TTS`、`基于 QA note 重写 Scene` (disabled when qaNote empty, tooltip `"请先填写 QA note"`)
  - On rewrite response: show `DiffView` of before/after narration with `接受改写`/`放弃改写`
  - Files: two `.tsx`
  - _Requirements: 13.1–13.10_

- [x] T41 Implement 6 tabs — read-only portions first
  - Create:
    - `src/components/workbench/tabs/brief-tab.tsx` (title/audience/corePoints/tone/targetDurationSec/suggestedStyle + "重新生成 Brief" confirm dialog)
    - `src/components/workbench/tabs/storyboard-tab.tsx` (scene rows opening `SceneDrawer`)
    - `src/components/workbench/tabs/html-tab.tsx` (read-only source viewer + preview link)
    - `src/components/workbench/tabs/audio-tab.tsx` (per-scene mp3 state, batch + per-scene regenerate, `<audio>` preview)
    - `src/components/workbench/tabs/render-tab.tsx` (log tail 200 lines + SSE progress + mp4 `<video>`)
    - `src/components/workbench/tabs/qa-tab.tsx` (notes list + add-note form, 2000 char limit)
  - Each tab uses `canEnterTab` to show empty-state card with CTA when gating fails (Req 12.11)
  - Files: 6 `.tsx`
  - _Requirements: 12.2–12.11, 13.1_

- [x] T42 Implement Render tab SSE client
  - Inside `render-tab.tsx`, open `EventSource("/api/projects/{id}/render/stream")` on mount
  - Update progress UI on `stage`/`line`/`heartbeat`/`error` events
  - Show `"连接已断开，点击重试"` on `eventSource.onerror` with manual reconnect button
  - Files: `src/components/workbench/tabs/render-tab.tsx` (extend)
  - _Requirements: 12.9, 10.7_

- [x] T43 Implement `LogViewer` popover
  - Create `src/components/workbench/log-viewer.tsx` that fetches `data/projects/{id}/logs/{stage}.log` tail (server action or API route — use new `GET /api/projects/[id]/logs/[stage]?tail=500`)
  - Shared failure banner component `stage-failure-banner.tsx` renders `error.code` + first 200 chars of `error.message` + "查看完整日志" link opening this popover
  - Files: `src/components/workbench/log-viewer.tsx`, `src/components/workbench/stage-failure-banner.tsx`, `src/app/api/projects/[id]/logs/[stage]/route.ts`
  - _Requirements: 14.4, 14.5_

- [x] T44 Implement `NewProjectDialog` + `ProjectRow`
  - Create `src/app/projects/_components/new-project-dialog.tsx` (title 1–80, topic 1–500, trim, inline validation errors, disable submit during request, call `POST /api/projects`, on success route to `/projects/{id}`)
  - Create `src/app/projects/_components/project-row.tsx` (title truncation >60 chars, relative time via `formatRelativeTime`, stage color block fallback when poster missing, delete confirm dialog)
  - Files: two `.tsx`
  - _Requirements: 11.3–11.8_

- [x] T45 Extend `sidebar.tsx` with `/projects` entry
  - Add "视频工作台" link pointing to `/projects`; match existing nav style (reuse same Header/Nav component)
  - Files: `src/components/sidebar.tsx`
  - _Requirements: 11.3_
  - [x]* T45.1 Update existing `sidebar.test.tsx` to assert the new link
    - Files: `src/components/sidebar.test.tsx`

- [x] T46 Checkpoint — UI components isolated render
  - Ensure all tests pass, ask the user if questions arise.

### Phase 5 — Pages

- [x] T47 Build `/projects` list page
  - Create `src/app/projects/page.tsx` (client component or server+client split)
  - Fetch `GET /api/projects`; sort by `updatedAt` desc; skeleton while loading; empty-state "暂无项目"
  - Client-side pagination at 20/page (prev/next)
  - Mount `NewProjectDialog` and delete confirm flow
  - Poster: `/videos/project-{id}.poster.jpg` with fallback to stage color block (map stage → fixed color)
  - Files: `src/app/projects/page.tsx`, `src/app/projects/_components/pagination.tsx`
  - _Requirements: 11.1–11.9_

- [x] T48 Build `/projects/[id]` detail page
  - Create `src/app/projects/[id]/page.tsx` with two-column layout: `StagePanel` (left) + Tab container (right)
  - Fetch `GET /api/projects/[id]` with SWR/polling every 5 s (satisfies Req 17.2 "3 秒内反映" while keeping server cost low — poll is faster when tab visible)
  - Render all 6 tabs; show "项目不存在或无法读取" error page with back link on 404/500
  - Files: `src/app/projects/[id]/page.tsx`, `src/app/projects/[id]/error.tsx`, `src/app/projects/[id]/not-found.tsx`
  - _Requirements: 12.1, 12.2, 12.12, 17.1, 17.2_

- [x] T49 Checkpoint — End-to-end page flows work with mocked backend
  - Ensure all tests pass, ask the user if questions arise.

### Phase 6 — End-to-end smoke

- [x] T50 Author mocked E2E smoke test
  - Add Playwright (`@playwright/test`) as dev dependency + minimal `playwright.config.ts`
  - Create `e2e/workbench-smoke.spec.ts`: start Next.js dev server with a stub `kiro-cli` binary on `PATH` emitting scripted JSON replies, MSW mocks for Azure Speech TTS, and a fake `hyperframes` script on `PATH`; walk topic → brief → storyboard → composition → audio → render → publish; assert final mp4 exists and detail page `<video>` loads
  - Files: `playwright.config.ts`, `e2e/workbench-smoke.spec.ts`, `e2e/fixtures/fake-hyperframes.mjs`
  - _Requirements: 17.1–17.7_
  - Acceptance: `npx playwright test` exits 0

- [ ]* T50.1 Live smoke behind `WORKBENCH_LIVE=1`
  - Same spec, no mocks; skipped unless env set; relies on real LLM + TTS + `../linear-launch`
  - Files: `e2e/workbench-live.spec.ts`
  - _Requirements: 17.3_

- [x] T51 Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

### Phase 7 — UI debug affordances (live preview + inline playback)

Increment on top of the completed spec to address pain-points from the first
real E2E run: composition generation is streamed per-scene but the HTML tab
cannot see sub-scene progress; generated audio cannot be auditioned inline;
and the Render tab's `<video>` must be verified against a real mp4.

- [x] T52 Implement `GET /api/projects/[id]/composition/scenes`
  - Create `src/app/api/projects/[id]/composition/scenes/route.ts`
  - For each scene in `project.storyboard.scenes`, resolve
    `composition/{sceneCompositionPath(scene)}` via `resolveProjectFile`
    + `assertUnderDataDir` and `fs.stat` it
  - Return `200 { scenes: [{ sceneId, index, title, compositionId, relPath, exists, size, updatedAt }] }`
    where `compositionId = sceneCompositionId(scene)`; `updatedAt` is the file `mtimeMs`
    as an ISO string (omit when `exists=false`)
  - `Cache-Control: no-store`
  - Errors: invalid projectId → 400 `INVALID_PROJECT_ID`; `readProject` failures → 404/500 per matrix
  - Files: `src/app/api/projects/[id]/composition/scenes/route.ts`
  - _Requirements: 12.5, 12.11, 14.1, 16.4, 16.6_
  - Acceptance: for a project with 11 scenes and 5 generated sub-composition
    files, the response contains 11 entries with `exists: true` on the 5
    whose files exist and `exists: false` on the rest

- [x] T53 Implement `GET /api/projects/[id]/composition/scenes/[compositionId]`
  - Create `src/app/api/projects/[id]/composition/scenes/[compositionId]/route.ts`
  - Validate `compositionId` matches `/^scene-\d{2}-[0-9a-f]{6}$/`; otherwise 400 `INVALID_COMPOSITION_ID`
  - Resolve `composition/compositions/{compositionId}.html` and 404 if missing
  - Read the sub-composition `<template>` bytes (the existing per-scene file)
    and wrap them in a minimal host document so an iframe renders the
    animation instead of a black page:
      * include `<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>`
      * on `DOMContentLoaded`, clone the `<template>`'s content into `document.body`,
        dispatch a `hyperframes:ready` event, then call
        `window.__timelines[compositionId].play()` when present
      * apply `html, body { margin: 0; background: #111; color: #fff; overflow: hidden; }`
      * set `<base target="_blank">` so no in-iframe link ever navigates the parent
  - Sanity-scan the sub-composition bytes with `scanHtml` before embedding; if a forbidden
    token appears (should never happen — writes already go through `scanHtml`) return 500
    `HTML_SCAN_REJECTED`
  - Respond `200 text/html; charset=utf-8; Cache-Control: no-store`
  - Files: `src/app/api/projects/[id]/composition/scenes/[compositionId]/route.ts`
  - _Requirements: 12.5, 12.11, 16.4, 16.6, 16.7_
  - Acceptance: loading the route for an existing `scene-01-53c377` in an iframe shows
    the real GSAP-driven animation (not a blank `<template>`)

- [x] T54 Implement `GET /api/projects/[id]/audio/scenes/[index]`
  - Create `src/app/api/projects/[id]/audio/scenes/[index]/route.ts`
  - Validate `index` parses as positive integer in `[1, MAX_SCENES]`; else 400 `INVALID_SCENE_INDEX`
  - Resolve `composition/assets/scene-{index}.mp3` via `resolveProjectFile` + `assertUnderDataDir`;
    404 `AUDIO_NOT_FOUND` if missing
  - Stream the file with `Content-Type: audio/mpeg`, `Content-Length`, `Accept-Ranges: bytes`,
    `Cache-Control: no-store`; honour `Range` header for the common `bytes=0-` player seek
  - Files: `src/app/api/projects/[id]/audio/scenes/[index]/route.ts`
  - _Requirements: 9.10, 12.6, 12.11, 16.4, 16.6_
  - Acceptance: an `<audio controls src="…/audio/scenes/3">` tag plays scene 3's mp3
    end-to-end; seeking via the scrubber issues valid `Range` requests and gets 206

- [x] T55 Add scene grid to `HtmlTab`
  - Extend `src/components/workbench/tabs/html-tab.tsx` with a grid above the raw
    source view when `project.stage >= "composition"` or `project.stageStatus.composition.status === "running"`
  - Grid card per scene from `project.storyboard.scenes`: index, title, status chip
    (`pending` when no file, `ready` when `exists:true`, `generating` when composition
    is running and file missing, `failed` when stage failed), file size, "点击预览" button
  - Poll `GET /api/projects/[id]/composition/scenes` every 2 s while
    `stageStatus.composition.status === "running"`, otherwise fetch once on mount and
    on every `project.updatedAt` change
  - Clicking "点击预览" opens a drawer (reuse existing shadcn `Sheet` pattern if
    available; else a lightweight inline `<dialog>`) containing an iframe whose `src`
    is `/api/projects/{id}/composition/scenes/{compositionId}`; sandbox the iframe
    with `allow-scripts` only (no `allow-same-origin`, no `allow-forms`, no top
    navigation) per Req 16.7 defence-in-depth
  - Keep the existing "重新生成 HTML" confirm flow and raw source viewer below the grid
  - Files: `src/components/workbench/tabs/html-tab.tsx` (extend), optional
    `src/components/workbench/tabs/_scene-grid.tsx` helper if the grid is large
    enough to warrant extraction
  - _Requirements: 12.5, 12.11, 12.12, 16.7, 17.2_
  - Acceptance: during an 11-scene composition generation run, the grid flips
    cards from "生成中" → "已生成" one by one as files appear on disk; clicking
    an already-ready scene opens the drawer and the iframe plays the animation

- [x] T56 Add per-scene inline audio player to `AudioTab`
  - Extend `src/components/workbench/tabs/audio-tab.tsx` so each scene row renders
    `<audio controls preload="metadata" src="/api/projects/{id}/audio/scenes/{index}">`
    **only when** `scene.audioPath !== null && scene.audioPath !== undefined`
  - Player sits below the narration preview line; width 100 %, compact height
  - Update the `StatusChip` to include a subtle affordance hinting playability
    (no behaviour change otherwise)
  - Files: `src/components/workbench/tabs/audio-tab.tsx`
  - _Requirements: 12.6, 12.11_
  - Acceptance: for a project with 11 scenes all generated, 11 `<audio>` players
    render and each plays the correct mp3

- [x] T57 Verify `RenderTab` `<video>` against real mp4
  - Walk `render-tab.tsx` against the existing test project
    `proj_1778375317741_8af0bd` (mp4 at `public/videos/project-proj_1778375317741_8af0bd.mp4`)
    and confirm the `<video controls src={videoPath}>` tag renders and plays
  - If the file is > 10 MB, add `preload="metadata"` to avoid force-download on
    first paint; otherwise no change
  - No new API routes — reuses the Next.js static handler on `public/videos/`
  - Files: `src/components/workbench/tabs/render-tab.tsx` (optional 1-line tweak)
  - _Requirements: 12.7_
  - Acceptance: opening `/projects/proj_1778375317741_8af0bd` with the mp4 present
    shows the video, scrubbing works, no console errors

- [x] T58 Checkpoint — Phase 7 live-preview smoke
  - Manually walk a fresh project through topic → brief → storyboard → composition
    (watch the scene grid light up) → audio (play scenes 1, 5, 11 inline) → render
    (verify inline video plays post-completion)
  - Run `npx vitest run src/lib/workbench/` to make sure existing 127 tests remain green
  - Files: — (smoke only)
  - _Requirements: 17.1, 17.2, 17.6_
  - Acceptance: all three debug affordances work end-to-end against a real project;
    existing vitest suite green
  - **Automated gate status** (run on 2026-05-10):
    - `npx vitest run src/lib/workbench/` — 19 files / 127 tests passed
    - `npx vitest run src/app/api/projects/` — 3 files / 14 tests passed (includes T52/T53/T54)
    - `npx vitest run src/components/workbench/` — 2 files / 7 tests passed (includes T55/T56)
    - `npx tsc --noEmit` — 0 Phase 7 errors; 15 pre-existing errors in unrelated files
  - **Manual gate status**: pending — Dale to walk through a real project end-to-end

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for faster MVP — core functionality tasks are never optional.
- Each task references specific requirements (e.g. `4.3`) and/or design properties (e.g. `Property 18`) for traceability.
- Checkpoints at T17, T25, T38, T46, T49, T51 keep incremental validation cheap.
- Property-based tests (fast-check) live next to the module they validate; integration tests use MSW for HTTP mocks and tmp-dir for fs isolation.
- The pure core (T04–T16) is standalone — it can be fully PBT-proven before any I/O or UI work begins.
- Route handlers (T27–T37) depend only on Phase 2 services; UI (T39–T48) can proceed in parallel with route handlers once Phase 1 types/schemas stabilise.
- Live smoke (T50.1) requires `AZURE_SPEECH_ENDPOINT` + `AZURE_SPEECH_KEY`, a working `kiro-cli` on `PATH`, `HYPERFRAMES_TEMPLATE_DIR` (or sibling `linear-launch`), and `WORKBENCH_LIVE=1`; it is off by default.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["T01", "T02", "T03"] },
    { "id": 1, "tasks": ["T04", "T05"] },
    { "id": 2, "tasks": ["T06.1", "T07.1", "T11.1", "T14.1", "T15.1", "T16.1"] },
    { "id": 3, "tasks": ["T08.1"] },
    { "id": 4, "tasks": ["T09.1", "T10.1", "T12.1", "T13.1", "T18.1", "T19.1"] },
    { "id": 5, "tasks": ["T06.2", "T07.2", "T07.3", "T08.2", "T09.2", "T09.3", "T09.4", "T09.5", "T09.6", "T10.2", "T10.3", "T11.2", "T12.2", "T13.2", "T14.2", "T15.2", "T16.2", "T18.2", "T19.2"] },
    { "id": 6, "tasks": ["T20.1", "T21.1"] },
    { "id": 7, "tasks": ["T20.2", "T20.3", "T20.4", "T21.2", "T21.3", "T21.4", "T22.1", "T23.1", "T24.1"] },
    { "id": 8, "tasks": ["T22.2", "T22.3", "T23.2", "T24.2", "T26"] },
    { "id": 9, "tasks": ["T27", "T28", "T29", "T30", "T31", "T32", "T33", "T34", "T35", "T36", "T37"] },
    { "id": 10, "tasks": ["T39", "T40", "T41", "T43", "T44", "T45", "T45.1"] },
    { "id": 11, "tasks": ["T42", "T47", "T48"] },
    { "id": 12, "tasks": ["T50", "T50.1"] },
    { "id": 13, "tasks": ["T52", "T53", "T54"] },
    { "id": 14, "tasks": ["T55", "T56", "T57"] },
    { "id": 15, "tasks": ["T58"] }
  ]
}
```
