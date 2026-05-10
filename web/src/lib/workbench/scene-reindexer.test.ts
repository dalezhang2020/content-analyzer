/**
 * Property-based tests for `scene-reindexer.ts`.
 *
 * Covers:
 *   - Property 9: Scene re-indexing preserves `[1..N]` under any edit
 *     sequence (composed via `fc.commands`).
 *   - Property 10: `applySceneEdit` clears `audioPath` iff `narration` or
 *     `voice` differs from the current scene; otherwise preserves it.
 *
 * _Validates: Requirements 3.3, 3.8, 3.9, 5.7, 5.9_
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  applySceneEdit,
  deleteScene,
  insertScene,
  moveScene,
} from "@/lib/workbench/scene-reindexer";
import { sceneArb as baseSceneArb } from "@/test/fixtures/project-builder";
import type { Scene } from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Full Scene arbitrary that satisfies `@/lib/workbench/types.Scene`.
 *
 * `audioPath` is either null or a canonical `assets/scene-{N}.mp3` path —
 * this is exactly what the TTSService emits, and what `remapAudioPath`
 * rewrites. Generating only canonical paths lets Property 9 check the
 * "every non-null audioPath matches `assets/scene-{index}.mp3`" invariant
 * directly. Custom-path behaviour (path preserved unchanged) is covered by
 * the module's unit docs, not by this property.
 */
const canonicalAudioPathArb: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 999 })
  .map((n) => `assets/scene-${n}.mp3`);

const voiceArb: fc.Arbitrary<string> = fc.constantFrom(
  "zh-CN-Xiaochen:DragonHDFlashLatestNeural",
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-YunxiNeural",
  "zh-CN-YunjianNeural",
);

const fullSceneArb: fc.Arbitrary<Scene> = fc
  .record({
    base: baseSceneArb,
    voice: voiceArb,
    audioPath: fc.option(canonicalAudioPathArb, { nil: null }),
    qaNote: fc.string({ minLength: 0, maxLength: 2000 }),
    updatedAt: fc
      .date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") })
      .map((d) => d.toISOString()),
  })
  .map(({ base, voice, audioPath, qaNote, updatedAt }) => ({
    sceneId: base.sceneId,
    index: base.index,
    title: base.title,
    narration: base.narration,
    durationSec: base.durationSec,
    voice,
    audioPath,
    qaNote,
    updatedAt,
  }));

/**
 * Arbitrary that generates a starting Storyboard of `[3, 20]` Scenes with
 * unique sceneIds (reindex does not dedupe ids; our commands do reference
 * scenes by id, so uniqueness keeps `deleteScene` deterministic).
 */
const initialScenesArb: fc.Arbitrary<Scene[]> = fc
  .uniqueArray(fullSceneArb, {
    minLength: 3,
    maxLength: 20,
    selector: (s) => s.sceneId,
  })
  .map((scenes) => reindexForSetup(scenes));

/**
 * Helper: assign fresh 1-based indexes to a freshly-built scenes array
 * and normalise any canonical audioPath to the new index. Mirrors what the
 * SUT's `reindex` would do, kept tiny and local so the test doesn't depend
 * on the SUT for test-setup itself.
 */
function reindexForSetup(scenes: Scene[]): Scene[] {
  return scenes.map((s, i) => {
    const idx = i + 1;
    const audioPath =
      s.audioPath !== null && /^assets\/scene-\d+\.mp3$/.test(s.audioPath)
        ? `assets/scene-${idx}.mp3`
        : s.audioPath;
    return { ...s, index: idx, audioPath };
  });
}

// ---------------------------------------------------------------------------
// Shared invariant check — Property 9 body
// ---------------------------------------------------------------------------

function assertStoryboardInvariants(scenes: Scene[]): void {
  // Indexes are 1..N, contiguous.
  for (let i = 0; i < scenes.length; i++) {
    expect(scenes[i].index).toBe(i + 1);
  }

  // Every non-null audioPath matches `assets/scene-{index}.mp3` where
  // `{index}` is the scene's own index. (Our arbitraries only ever produce
  // canonical paths, so any non-null path MUST be canonical after reindex.)
  for (const scene of scenes) {
    if (scene.audioPath !== null) {
      expect(scene.audioPath).toBe(`assets/scene-${scene.index}.mp3`);
    }
  }
}

// ---------------------------------------------------------------------------
// fc.commands definitions for Property 9
// ---------------------------------------------------------------------------

interface Model {
  /** Mirror of the scene count; used by `check` to reject impossible ops. */
  length: number;
}

interface Real {
  scenes: Scene[];
}

class InsertCommand implements fc.Command<Model, Real> {
  constructor(
    readonly at: number,
    readonly newScene: Scene,
  ) {}
  check(_m: Readonly<Model>): boolean {
    return true; // always applicable
  }
  run(m: Model, r: Real): void {
    r.scenes = insertScene(r.scenes, this.at, this.newScene);
    m.length = r.scenes.length;
    assertStoryboardInvariants(r.scenes);
  }
  toString(): string {
    return `insert(at=${this.at}, id=${this.newScene.sceneId})`;
  }
}

class DeleteCommand implements fc.Command<Model, Real> {
  constructor(readonly pickIdx: number) {}
  check(m: Readonly<Model>): boolean {
    // Deleting into an empty storyboard is a no-op; skip rather than exercise.
    return m.length > 0;
  }
  run(m: Model, r: Real): void {
    const i =
      ((this.pickIdx % r.scenes.length) + r.scenes.length) % r.scenes.length;
    const target = r.scenes[i].sceneId;
    r.scenes = deleteScene(r.scenes, target);
    m.length = r.scenes.length;
    assertStoryboardInvariants(r.scenes);
  }
  toString(): string {
    return `delete(pickIdx=${this.pickIdx})`;
  }
}

class MoveCommand implements fc.Command<Model, Real> {
  constructor(
    readonly from: number,
    readonly to: number,
  ) {}
  check(m: Readonly<Model>): boolean {
    return m.length > 0;
  }
  run(m: Model, r: Real): void {
    const len = r.scenes.length;
    const src = ((this.from % len) + len) % len;
    const dst = ((this.to % len) + len) % len;
    r.scenes = moveScene(r.scenes, src, dst);
    m.length = r.scenes.length;
    assertStoryboardInvariants(r.scenes);
  }
  toString(): string {
    return `move(from=${this.from}, to=${this.to})`;
  }
}

class ApplyEditCommand implements fc.Command<Model, Real> {
  constructor(
    readonly pickIdx: number,
    readonly patch: Partial<
      Pick<Scene, "title" | "narration" | "durationSec" | "voice" | "qaNote">
    >,
    readonly now: string,
  ) {}
  check(m: Readonly<Model>): boolean {
    return m.length > 0;
  }
  run(_m: Model, r: Real): void {
    const i =
      ((this.pickIdx % r.scenes.length) + r.scenes.length) % r.scenes.length;
    const edited = applySceneEdit(r.scenes[i], this.patch, this.now);
    // applySceneEdit operates on a single scene; reflect it back into the
    // array by hand (the SUT does not take an array API for this).
    const next = r.scenes.slice();
    next[i] = { ...edited, index: r.scenes[i].index };
    r.scenes = next;
    assertStoryboardInvariants(r.scenes);
  }
  toString(): string {
    return `applyEdit(pickIdx=${this.pickIdx}, fields=[${Object.keys(this.patch).join(",")}])`;
  }
}

// Individual command arbitraries.
const insertCmdArb = fc
  .record({
    at: fc.integer({ min: 0, max: 25 }),
    newScene: fullSceneArb,
  })
  .map(({ at, newScene }) => new InsertCommand(at, newScene));

const deleteCmdArb = fc
  .integer({ min: 0, max: 1_000 })
  .map((pickIdx) => new DeleteCommand(pickIdx));

const moveCmdArb = fc
  .record({
    from: fc.integer({ min: 0, max: 25 }),
    to: fc.integer({ min: 0, max: 25 }),
  })
  .map(({ from, to }) => new MoveCommand(from, to));

const editPatchArb: fc.Arbitrary<
  Partial<Pick<Scene, "title" | "narration" | "durationSec" | "voice" | "qaNote">>
> = fc.record(
  {
    title: fc.string({ minLength: 1, maxLength: 40 }),
    narration: fc.string({ minLength: 1, maxLength: 280 }),
    durationSec: fc.integer({ min: 1, max: 60 }),
    voice: voiceArb,
    qaNote: fc.string({ minLength: 0, maxLength: 2000 }),
  },
  { requiredKeys: [] },
);

const applyEditCmdArb = fc
  .record({
    pickIdx: fc.integer({ min: 0, max: 1_000 }),
    patch: editPatchArb,
    now: fc
      .date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") })
      .map((d) => d.toISOString()),
  })
  .map(({ pickIdx, patch, now }) => new ApplyEditCommand(pickIdx, patch, now));

// ---------------------------------------------------------------------------
// Property 9
// ---------------------------------------------------------------------------

describe("Property 9: scene re-indexing preserves [1..N] under any edit sequence", () => {
  it("maintains contiguous 1-based indexes and canonical audioPath after every op", () => {
    fc.assert(
      fc.property(
        initialScenesArb,
        fc.commands(
          [insertCmdArb, deleteCmdArb, moveCmdArb, applyEditCmdArb],
          { maxCommands: 40 },
        ),
        (initialScenes, cmds) => {
          const setup = () => ({
            model: { length: initialScenes.length },
            real: { scenes: initialScenes.slice() },
          });
          fc.modelRun(setup, cmds);
        },
      ),
      // Keep numRuns modest — each run executes up to 40 mutations with
      // full invariant checks. Global seed comes from setup.ts.
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

describe("Property 10: editing narration or voice invalidates cached audio", () => {
  it("clears audioPath iff narration or voice changes; preserves it otherwise", () => {
    fc.assert(
      fc.property(
        fullSceneArb,
        editPatchArb,
        fc
          .date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") })
          .map((d) => d.toISOString()),
        (scene, patch, now) => {
          const edited = applySceneEdit(scene, patch, now);

          const narrationChanged =
            patch.narration !== undefined && patch.narration !== scene.narration;
          const voiceChanged =
            patch.voice !== undefined && patch.voice !== scene.voice;
          const shouldInvalidate = narrationChanged || voiceChanged;

          if (shouldInvalidate) {
            expect(edited.audioPath).toBeNull();
          } else {
            expect(edited.audioPath).toBe(scene.audioPath);
          }
        },
      ),
    );
  });

  it("preserves audioPath when the patch only touches title/qaNote/durationSec", () => {
    const nonInvalidatingPatchArb: fc.Arbitrary<
      Partial<
        Pick<Scene, "title" | "durationSec" | "qaNote">
      >
    > = fc.record(
      {
        title: fc.string({ minLength: 1, maxLength: 40 }),
        durationSec: fc.integer({ min: 1, max: 60 }),
        qaNote: fc.string({ minLength: 0, maxLength: 2000 }),
      },
      { requiredKeys: [] },
    );

    fc.assert(
      fc.property(
        fullSceneArb,
        nonInvalidatingPatchArb,
        fc
          .date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") })
          .map((d) => d.toISOString()),
        (scene, patch, now) => {
          const edited = applySceneEdit(scene, patch, now);
          expect(edited.audioPath).toBe(scene.audioPath);
          // Sanity: untouched fields match.
          expect(edited.voice).toBe(scene.voice);
          expect(edited.narration).toBe(scene.narration);
        },
      ),
    );
  });

  it("clears audioPath when narration is set to a different value (explicit)", () => {
    const scene: Scene = {
      sceneId: "sc_abcd1234",
      index: 1,
      title: "t",
      narration: "original narration",
      durationSec: 5,
      voice: "zh-CN-XiaoxiaoNeural",
      audioPath: "assets/scene-1.mp3",
      qaNote: "",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };

    const edited = applySceneEdit(
      scene,
      { narration: "different narration" },
      "2024-06-01T00:00:00.000Z",
    );

    expect(edited.audioPath).toBeNull();
    expect(edited.narration).toBe("different narration");
    expect(edited.updatedAt).toBe("2024-06-01T00:00:00.000Z");
  });

  it("preserves audioPath when narration patch is identical to current value", () => {
    const scene: Scene = {
      sceneId: "sc_abcd1234",
      index: 2,
      title: "t",
      narration: "same narration",
      durationSec: 5,
      voice: "zh-CN-XiaoxiaoNeural",
      audioPath: "assets/scene-2.mp3",
      qaNote: "",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };

    const edited = applySceneEdit(
      scene,
      { narration: "same narration" },
      "2024-06-01T00:00:00.000Z",
    );

    expect(edited.audioPath).toBe("assets/scene-2.mp3");
  });
});
