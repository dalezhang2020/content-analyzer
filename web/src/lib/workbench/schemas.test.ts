import { describe, expect, it } from "vitest";
import fc from "fast-check";

// Feature: video-creation-workbench — T08.2
//
// Property 5: Project and Scene schema round-trip.
// For any conforming Project object built from the zod generators,
// `ProjectSchema.parse(JSON.parse(JSON.stringify(project)))` equals the
// original project (structural equality); for any JSON object that fails
// to satisfy ProjectSchema, `safeParse` returns `{ success: false }`.
//
// **Validates: Requirements 1.7, 2.2, 2.11, 2.12, 3.1, 3.2, 3.4, 3.5, 3.6, 3.7**

import {
  ProjectSchema,
  SceneSchema,
} from "@/lib/workbench/schemas";
import { projectArb, sceneArb } from "@/test/fixtures/project-builder";

/**
 * JSON round-trip: normalise any date / control-char concerns by going
 * through `JSON.stringify` → `JSON.parse`. For plain JSON values this is a
 * structural identity.
 */
function jsonRoundTrip<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v));
}

describe("schemas — Property 5: Project & Scene round-trip", () => {
  // -------------------------------------------------------------------------
  // Positive: every generated Project round-trips through ProjectSchema.
  // -------------------------------------------------------------------------
  it("ProjectSchema.parse(JSON-round-trip(project)) === project", () => {
    fc.assert(
      fc.property(projectArb, (project) => {
        const roundTripped = jsonRoundTrip(project);
        const parsed = ProjectSchema.parse(roundTripped);
        expect(parsed).toEqual(project);
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Positive: every generated Scene round-trips through SceneSchema.
  // -------------------------------------------------------------------------
  it("SceneSchema.parse(JSON-round-trip(scene)) === scene", () => {
    fc.assert(
      fc.property(sceneArb, (scene) => {
        const roundTripped = jsonRoundTrip(scene);
        const parsed = SceneSchema.parse(roundTripped);
        expect(parsed).toEqual(scene);
      }),
    );
  });
});

describe("schemas — Property 5: negative rejection cases", () => {
  // Minimal, schema-valid Project used as a mutation base. Every subsequent
  // negative test starts from this value and perturbs one field.
  function makeValidProject() {
    return {
      schemaVersion: 1 as const,
      projectId: "proj_1715200000000_a1b2c3",
      title: "Valid project",
      topic: "A valid topic",
      locale: "zh-CN" as const,
      stage: "topic" as const,
      stageStatus: {
        topic: { status: "pending" as const },
        brief: { status: "pending" as const },
        storyboard: { status: "pending" as const },
        composition: { status: "pending" as const },
        audio: { status: "pending" as const },
        render: { status: "pending" as const },
        qa: { status: "pending" as const },
        published: { status: "pending" as const },
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
      templateSource: {
        name: "linear-launch",
        version: "0.5.5",
        sourcePath: "/tmp/linear-launch",
      },
      createdAt: new Date("2025-01-01T00:00:00Z").toISOString(),
      updatedAt: new Date("2025-01-01T00:00:00Z").toISOString(),
    };
  }

  function makeValidScene() {
    return {
      sceneId: "sc_abcdef12",
      index: 1,
      title: "Scene one",
      narration: "This is narration text.",
      durationSec: 5,
      voice: "zh-CN-XiaoxiaoNeural",
      audioPath: null,
      qaNote: "",
      updatedAt: new Date("2025-01-01T00:00:00Z").toISOString(),
    };
  }

  // Baseline sanity: the fixtures above actually parse.
  it("baseline Project and Scene parse successfully", () => {
    expect(ProjectSchema.safeParse(makeValidProject()).success).toBe(true);
    expect(SceneSchema.safeParse(makeValidScene()).success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Control-char injection (Requirement 16.3, surfaced via 2.2 / 3.1)
  // -------------------------------------------------------------------------
  it("rejects Project.title containing any ASCII control character", () => {
    fc.assert(
      fc.property(
        // 0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F, 0x7F — matches scrubControlChars.
        fc.constantFrom(
          0x00, 0x01, 0x02, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f,
        ),
        (code) => {
          const bad = makeValidProject();
          bad.title = `hello${String.fromCharCode(code)}world`;
          expect(ProjectSchema.safeParse(bad).success).toBe(false);
        },
      ),
    );
  });

  it("rejects Scene.narration containing any ASCII control character", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          0x00, 0x01, 0x02, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f,
        ),
        (code) => {
          const bad = makeValidScene();
          bad.narration = `narr${String.fromCharCode(code)}text`;
          expect(SceneSchema.safeParse(bad).success).toBe(false);
        },
      ),
    );
  });

  it("rejects QaNote.text containing any ASCII control character", () => {
    const bad = makeValidProject();
    bad.qaNotes = [
      {
        noteId: "qan_abcdef12",
        sceneId: null,
        text: `note${String.fromCharCode(0x00)}with-nul`,
        author: "local" as const,
        createdAt: new Date("2025-01-01T00:00:00Z").toISOString(),
      },
    ];
    expect(ProjectSchema.safeParse(bad).success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // schemaVersion ≠ 1 (Requirement 2.11, 2.12)
  // -------------------------------------------------------------------------
  it("rejects any schemaVersion other than 1", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: -100, max: 100 })
          .filter((n) => n !== 1),
        (wrongVersion) => {
          const bad = makeValidProject() as unknown as {
            schemaVersion: number;
          };
          bad.schemaVersion = wrongVersion;
          expect(
            ProjectSchema.safeParse(bad as unknown).success,
          ).toBe(false);
        },
      ),
    );
  });

  it("rejects a non-numeric schemaVersion", () => {
    const bad = {
      ...makeValidProject(),
      schemaVersion: "1" as unknown as 1,
    };
    expect(ProjectSchema.safeParse(bad).success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Storyboard scene count outside [3..20] (Requirement 5.3 / structural
  // bound declared on StoryboardSchema; reached via ProjectSchema.storyboard)
  // -------------------------------------------------------------------------
  it("rejects a storyboard with fewer than 3 scenes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 }), (count) => {
        const scenes = Array.from({ length: count }, (_, i) => ({
          ...makeValidScene(),
          sceneId: `sc_0000000${i}`,
          index: i + 1,
        }));
        const bad = { ...makeValidProject(), storyboard: { scenes } };
        expect(ProjectSchema.safeParse(bad).success).toBe(false);
      }),
    );
  });

  it("rejects a storyboard with more than 20 scenes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 21, max: 30 }), (count) => {
        const scenes = Array.from({ length: count }, (_, i) => ({
          ...makeValidScene(),
          // sceneId must be `sc_{8 lower alnum}` — pad with zeros.
          sceneId: `sc_${String(i).padStart(8, "0").slice(-8)}`,
          index: i + 1,
        }));
        const bad = { ...makeValidProject(), storyboard: { scenes } };
        expect(ProjectSchema.safeParse(bad).success).toBe(false);
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Narration / title length bounds (Requirements 3.1, 3.5)
  // -------------------------------------------------------------------------
  it("rejects Scene.narration longer than 2000 chars (post-rewrite upper bound)", () => {
    const bad = { ...makeValidScene(), narration: "a".repeat(2001) };
    expect(SceneSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects Scene.narration that is the empty string", () => {
    const bad = { ...makeValidScene(), narration: "" };
    expect(SceneSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects Scene.title longer than 40 chars", () => {
    const bad = { ...makeValidScene(), title: "a".repeat(41) };
    expect(SceneSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects Scene.title that is the empty string", () => {
    const bad = { ...makeValidScene(), title: "" };
    expect(SceneSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects Project.title longer than 200 chars", () => {
    const bad = { ...makeValidProject(), title: "a".repeat(201) };
    expect(ProjectSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects Project.topic longer than 500 chars", () => {
    const bad = { ...makeValidProject(), topic: "a".repeat(501) };
    expect(ProjectSchema.safeParse(bad).success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scene.durationSec outside [1..60] (Requirement 3.4)
  // -------------------------------------------------------------------------
  it("rejects Scene.durationSec <= 0 or > 60", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -100, max: 0 }),
          fc.integer({ min: 61, max: 10_000 }),
        ),
        (bad) => {
          expect(
            SceneSchema.safeParse({ ...makeValidScene(), durationSec: bad })
              .success,
          ).toBe(false);
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Scene.voice: empty or non-string (Requirement 3.6)
  // -------------------------------------------------------------------------
  it("rejects Scene.voice that is the empty string", () => {
    const bad = { ...makeValidScene(), voice: "" };
    expect(SceneSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects Scene.voice that is not a string", () => {
    const bad = {
      ...makeValidScene(),
      voice: 123 as unknown as string,
    };
    expect(SceneSchema.safeParse(bad).success).toBe(false);
  });

  // Note: `VoiceSchema` is `z.string().min(1).max(200)` without a
  // `safeStr()` wrapper, so control-char rejection on `voice` is enforced
  // at the route/handler layer (per Requirement 3.6 → HTTP 400), not here.
  // Control-char rejection at the schema round-trip layer is covered by
  // the title / narration / qaNote cases above.

  // -------------------------------------------------------------------------
  // Scene.qaNote longer than 2000 chars (Requirement 3.7)
  // -------------------------------------------------------------------------
  it("rejects Scene.qaNote longer than 2000 chars", () => {
    const bad = { ...makeValidScene(), qaNote: "a".repeat(2001) };
    expect(SceneSchema.safeParse(bad).success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // sceneId / projectId regex (Requirements 3.2, 2.3)
  // -------------------------------------------------------------------------
  it("rejects Scene.sceneId that does not match ^sc_[a-z0-9]{8}$", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "abc",
          "sc_",
          "sc_ABCDEF12", // uppercase
          "scene_12345678",
          "sc_1234567", // 7 chars
          "sc_123456789", // 9 chars
          "sc_!@#$%^&*",
          "",
        ),
        (badId) => {
          const bad = { ...makeValidScene(), sceneId: badId };
          expect(SceneSchema.safeParse(bad).success).toBe(false);
        },
      ),
    );
  });

  it("rejects Project.projectId that does not match ^proj_[0-9]+_[a-z0-9]{6}$", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "proj",
          "proj_abc_123456", // non-numeric middle
          "proj_123_ABCDEF", // uppercase suffix
          "proj_123_abcde", // 5-char suffix
          "PROJ_123_abcdef", // uppercase prefix
          "../proj_123_abcdef", // traversal
          "",
        ),
        (badId) => {
          const bad = { ...makeValidProject(), projectId: badId };
          expect(ProjectSchema.safeParse(bad).success).toBe(false);
        },
      ),
    );
  });
});
