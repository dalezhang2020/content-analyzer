/**
 * Route test for `POST /api/projects/{id}/scenes/bulk-voice`.
 *
 * Verifies the atomic bulk-voice endpoint that replaces the client-side
 * N-PATCH fan-out. Covers:
 *   - Happy path: 200, every scene's voice updated and `audioPath` cleared,
 *     on-disk project.json reflects the change, updatedCount === N.
 *   - Stage policy: a `published` project is accepted (regression test
 *     for the INVALID_STAGE bug Dale hit on
 *     `proj_1778375317741_8af0bd`).
 *   - Missing storyboard → 409 `INVALID_STAGE`.
 *   - Invalid body (`voice: ""`) → 400 `VALIDATION_FAILED`.
 *
 * Setup mirrors `composition/scenes/route.test.ts`: each test gets a
 * fresh tmp dir via `createTmpDir`, and `WORKBENCH_DATA_DIR` is pointed
 * at it. `getDataDirAbs()` reads the env on every call, so no
 * `process.chdir` is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { NextRequest } from "next/server";

import { POST } from "./route";
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
    voice: "zh-CN-YunxiNeural",
    audioPath: `assets/scene-${index}.mp3`,
    qaNote: "",
    updatedAt: new Date().toISOString(),
  };
}

let tmp: TmpDir;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await createTmpDir("workbench-bulk-voice-route-");
  originalEnv = process.env.WORKBENCH_DATA_DIR;
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
 * Seed a project on disk with 3 scenes, each with `voice =
 * "zh-CN-YunxiNeural"` and a non-null canonical `audioPath`. Stage is
 * set to the caller-supplied value (default `composition`).
 */
async function seedProject(
  stage: Project["stage"] = "composition",
): Promise<Project> {
  const created = await createProject(
    { title: "Bulk Voice Test", topic: "Test topic", locale: "zh-CN" },
    fakeTemplateSource(),
  );

  const scenes: Scene[] = [
    makeScene(1, "11111111"),
    makeScene(2, "22222222"),
    makeScene(3, "33333333"),
  ];

  const withStoryboard: Project = {
    ...created,
    stage,
    storyboard: { scenes },
  };
  await writeProject(withStoryboard);
  return withStoryboard;
}

/**
 * Seed a project with no storyboard. Stage defaults to `topic`.
 */
async function seedProjectWithoutStoryboard(): Promise<Project> {
  const created = await createProject(
    { title: "No Storyboard", topic: "Test topic", locale: "zh-CN" },
    fakeTemplateSource(),
  );
  // `createProject` writes with storyboard === null by default; no
  // further writeProject call is needed.
  return created;
}

/**
 * Read the persisted project.json directly so we assert the atomic
 * write landed on disk (not just the in-memory response body).
 */
async function readPersistedProject(projectId: string): Promise<Project> {
  const abs = path.join(tmp.path, `${projectId}.json`);
  const text = await readFile(abs, "utf-8");
  return JSON.parse(text) as Project;
}

function buildRequest(body: unknown): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/projects/[id]/scenes/bulk-voice", () => {
  const newVoice = "zh-CN-Xiaochen:DragonHDFlashLatestNeural";

  it("applies the new voice to every scene, clears audioPath, and persists atomically", async () => {
    const project = await seedProject("composition");

    const res = await POST(
      buildRequest({ voice: newVoice }) as unknown as NextRequest,
      { params: Promise.resolve({ id: project.projectId }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: Project;
      updatedCount: number;
    };

    expect(body.updatedCount).toBe(3);
    expect(body.project.storyboard?.scenes).toHaveLength(3);
    for (const scene of body.project.storyboard!.scenes) {
      expect(scene.voice).toBe(newVoice);
      // `applySceneEdit` clears audioPath when voice changes
      // (Property 10). Every seeded scene had a non-null audioPath, so
      // every returned scene should now be null.
      expect(scene.audioPath).toBeNull();
    }

    // Persisted project.json mirrors the response.
    const persisted = await readPersistedProject(project.projectId);
    expect(persisted.storyboard?.scenes).toHaveLength(3);
    for (const scene of persisted.storyboard!.scenes) {
      expect(scene.voice).toBe(newVoice);
      expect(scene.audioPath).toBeNull();
    }
  });

  it("accepts a bulk-voice change on a `published` project (policy regression)", async () => {
    // This is the key policy fix — the per-scene PATCH route rejects
    // `published` with INVALID_STAGE, but a voice-only edit is a
    // corrective operation that does not require stage regression.
    const project = await seedProject("published");

    const res = await POST(
      buildRequest({ voice: newVoice }) as unknown as NextRequest,
      { params: Promise.resolve({ id: project.projectId }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: Project;
      updatedCount: number;
    };
    expect(body.updatedCount).toBe(3);
    // Stage is preserved — voice edits never change stage.
    expect(body.project.stage).toBe("published");
    for (const scene of body.project.storyboard!.scenes) {
      expect(scene.voice).toBe(newVoice);
      expect(scene.audioPath).toBeNull();
    }

    const persisted = await readPersistedProject(project.projectId);
    expect(persisted.stage).toBe("published");
    for (const scene of persisted.storyboard!.scenes) {
      expect(scene.voice).toBe(newVoice);
    }
  });

  it("returns 409 INVALID_STAGE when the project has no storyboard", async () => {
    const project = await seedProjectWithoutStoryboard();

    const res = await POST(
      buildRequest({ voice: newVoice }) as unknown as NextRequest,
      { params: Promise.resolve({ id: project.projectId }) },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_STAGE");
  });

  it("returns 400 VALIDATION_FAILED when voice is empty", async () => {
    const project = await seedProject("composition");

    const res = await POST(
      buildRequest({ voice: "" }) as unknown as NextRequest,
      { params: Promise.resolve({ id: project.projectId }) },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");

    // Nothing persisted — scenes should retain their original voice.
    const persisted = await readPersistedProject(project.projectId);
    for (const scene of persisted.storyboard!.scenes) {
      expect(scene.voice).toBe("zh-CN-YunxiNeural");
    }
  });
});
