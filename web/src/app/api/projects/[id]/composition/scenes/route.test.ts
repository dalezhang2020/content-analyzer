/**
 * Route test for `GET /api/projects/{id}/composition/scenes`.
 *
 * Verifies:
 *   - 200 response lists every scene in the storyboard with correct
 *     `exists` / `size` / `updatedAt` wiring for both present and missing
 *     sub-composition files.
 *   - Invalid project id → 400 `INVALID_PROJECT_ID`.
 *
 * Setup strategy: each test gets a fresh tmp dir via `createTmpDir`, and
 * `WORKBENCH_DATA_DIR` is pointed at that dir. `getDataDirAbs()` reads
 * the env on each call so we don't need `process.chdir`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { GET } from "./route";
import {
  sceneCompositionId,
  sceneCompositionPath,
} from "@/lib/workbench/ai-generator";
import { createProject, writeProject } from "@/lib/workbench/project-store";
import { createTmpDir, type TmpDir } from "@/test/fixtures/tmp-dir";
import type { Project, Scene, TemplateSource } from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeTemplateSource(): TemplateSource {
  return {
    name: "linear-launch",
    version: "0.0.0-test",
    sourcePath: "/irrelevant",
  };
}

function makeScene(index: number, hex: string): Scene {
  return {
    sceneId: `sc_${hex}`,
    index,
    title: `Scene ${index}`,
    narration: `Narration for scene ${index}.`,
    durationSec: 5,
    voice: "zh-CN-XiaochenNeural",
    audioPath: null,
    qaNote: "",
    updatedAt: new Date().toISOString(),
  };
}

let tmp: TmpDir;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await createTmpDir("workbench-scenes-route-");
  originalEnv = process.env.WORKBENCH_DATA_DIR;
  // `getDataDirAbs()` reads this env on every call, so we can avoid
  // process.chdir and still sandbox the test.
  process.env.WORKBENCH_DATA_DIR = tmp.path;
});

afterEach(async () => {
  if (originalEnv === undefined) {
    delete process.env.WORKBENCH_DATA_DIR;
  } else {
    process.env.WORKBENCH_DATA_DIR = originalEnv;
  }
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a project on disk with 3 scenes in its storyboard. Returns the
 * persisted Project so tests can read its `projectId` and scenes.
 */
async function seedProjectWithThreeScenes(): Promise<Project> {
  const created = await createProject(
    { title: "Scenes Test", topic: "Test topic", locale: "zh-CN" },
    fakeTemplateSource(),
  );

  const scenes: Scene[] = [
    makeScene(1, "11111111"),
    makeScene(2, "22222222"),
    makeScene(3, "33333333"),
  ];

  const withStoryboard: Project = {
    ...created,
    storyboard: { scenes },
  };
  await writeProject(withStoryboard);
  return withStoryboard;
}

/**
 * Write a sub-composition HTML file for a given scene inside the
 * project's `composition/compositions/` dir.
 */
async function writeSubCompositionFile(
  projectId: string,
  scene: Scene,
  contents: string,
): Promise<string> {
  const rel = sceneCompositionPath(scene);
  const abs = path.join(tmp.path, projectId, "composition", rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, contents, "utf-8");
  return abs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/projects/[id]/composition/scenes", () => {
  it("lists all 3 scenes with exists/size/updatedAt reflecting disk state", async () => {
    const project = await seedProjectWithThreeScenes();
    const [scene1, , scene3] = project.storyboard!.scenes;

    // Write sub-composition files for scene 1 and 3; leave scene 2 missing.
    const scene1Html = "<template><div>scene 1 composition</div></template>";
    const scene3Html =
      "<template><div>scene 3 composition body here</div></template>";
    await writeSubCompositionFile(project.projectId, scene1, scene1Html);
    await writeSubCompositionFile(project.projectId, scene3, scene3Html);

    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: project.projectId }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = (await res.json()) as {
      scenes: Array<{
        sceneId: string;
        index: number;
        title: string;
        compositionId: string;
        relPath: string;
        exists: boolean;
        size: number;
        updatedAt?: string;
      }>;
    };

    expect(body.scenes).toHaveLength(3);

    const bySceneId = new Map(body.scenes.map((s) => [s.sceneId, s]));

    // Scene 1 — present
    const entry1 = bySceneId.get(scene1.sceneId)!;
    expect(entry1).toBeDefined();
    expect(entry1.index).toBe(1);
    expect(entry1.title).toBe(scene1.title);
    expect(entry1.compositionId).toBe(sceneCompositionId(scene1));
    expect(entry1.relPath).toBe(sceneCompositionPath(scene1));
    expect(entry1.exists).toBe(true);
    expect(entry1.size).toBeGreaterThan(0);
    expect(entry1.size).toBe(Buffer.byteLength(scene1Html, "utf-8"));
    expect(entry1.updatedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(entry1.updatedAt!))).toBe(false);

    // Scene 2 — missing
    const scene2 = project.storyboard!.scenes[1];
    const entry2 = bySceneId.get(scene2.sceneId)!;
    expect(entry2).toBeDefined();
    expect(entry2.exists).toBe(false);
    expect(entry2.size).toBe(0);
    expect(entry2.updatedAt).toBeUndefined();

    // Scene 3 — present
    const entry3 = bySceneId.get(scene3.sceneId)!;
    expect(entry3).toBeDefined();
    expect(entry3.index).toBe(3);
    expect(entry3.exists).toBe(true);
    expect(entry3.size).toBe(Buffer.byteLength(scene3Html, "utf-8"));
    expect(entry3.updatedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(entry3.updatedAt!))).toBe(false);
  });

  it("returns 400 with error.code for an invalid project id", async () => {
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "../escape" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe("INVALID_PROJECT_ID");
  });
});
