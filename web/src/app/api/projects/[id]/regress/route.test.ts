/**
 * Route test for `POST /api/projects/{id}/regress`.
 *
 * Covers the manual stage-regression endpoint that unblocks users when
 * the strict `applyTransition` guards leave them stuck on a terminal
 * stage (e.g. `published`) with per-stage errors like `INVALID_STAGE:
 * Audio generation requires stage=composition`.
 *
 * Setup mirrors `scenes/bulk-voice/route.test.ts`: each test gets a
 * fresh tmp dir via `createTmpDir`, and `WORKBENCH_DATA_DIR` points at
 * it. `getDataDirAbs()` reads the env on every call, so no
 * `process.chdir` is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { NextRequest } from "next/server";

import { POST } from "./route";
import { createProject, writeProject } from "@/lib/workbench/project-store";
import { initialStageStatusMap } from "@/lib/workbench/state-machine";
import { createTmpDir, type TmpDir } from "@/test/fixtures/tmp-dir";
import type {
  Project,
  Scene,
  StageStatusMap,
  TemplateSource,
} from "@/lib/workbench/types";

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

/**
 * Build a fully-populated stageStatus map with every stage marked
 * "succeeded" — mirrors the shape of a project that ran clean through
 * the whole pipeline and landed on `published`.
 */
function succeededStageStatus(): StageStatusMap {
  const map = initialStageStatusMap();
  const now = "2024-01-01T00:00:00.000Z";
  for (const stage of Object.keys(map) as (keyof StageStatusMap)[]) {
    map[stage] = {
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      attempts: 1,
    };
  }
  return map;
}

let tmp: TmpDir;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await createTmpDir("workbench-regress-route-");
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
 * Seed a project at the given stage. When `published` is requested, the
 * project also carries a 3-scene storyboard + every stageStatus marked
 * "succeeded" — matching Dale's blocked-on-published scenario.
 */
async function seedProject(
  stage: Project["stage"],
): Promise<Project> {
  const created = await createProject(
    { title: "Regress Route Test", topic: "Test topic", locale: "zh-CN" },
    fakeTemplateSource(),
  );

  const scenes: Scene[] = [
    makeScene(1, "11111111"),
    makeScene(2, "22222222"),
    makeScene(3, "33333333"),
  ];

  const next: Project = {
    ...created,
    stage,
    stageStatus: succeededStageStatus(),
    storyboard: { scenes },
  };
  await writeProject(next);
  return next;
}

/**
 * Seed a minimal project sitting at an early stage (default `brief`)
 * with nothing downstream marked succeeded.
 */
async function seedEarlyProject(
  stage: Project["stage"] = "brief",
): Promise<Project> {
  const created = await createProject(
    { title: "Early Regress Test", topic: "Test topic", locale: "zh-CN" },
    fakeTemplateSource(),
  );
  const next: Project = { ...created, stage };
  await writeProject(next);
  return next;
}

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

function buildEmptyRequest(): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/projects/[id]/regress", () => {
  it("regresses published → composition, resets composition+downstream to pending, preserves upstream, appends history", async () => {
    const project = await seedProject("published");

    const res = await POST(
      buildRequest({
        target: "composition",
        reason: "need to rework HTML",
      }) as unknown as NextRequest,
      { params: Promise.resolve({ id: project.projectId }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Project;
    expect(body.stage).toBe("composition");

    // composition, audio, render, qa, published → pending
    expect(body.stageStatus.composition).toEqual({ status: "pending" });
    expect(body.stageStatus.audio).toEqual({ status: "pending" });
    expect(body.stageStatus.render).toEqual({ status: "pending" });
    expect(body.stageStatus.qa).toEqual({ status: "pending" });
    expect(body.stageStatus.published).toEqual({ status: "pending" });

    // topic, brief, storyboard → succeeded (preserved)
    expect(body.stageStatus.topic.status).toBe("succeeded");
    expect(body.stageStatus.brief.status).toBe("succeeded");
    expect(body.stageStatus.storyboard.status).toBe("succeeded");

    // History entry appended with fromStage=published.
    const last = body.stageHistory.at(-1);
    expect(last).toBeDefined();
    expect(last?.fromStage).toBe("published");
    expect(last?.toStage).toBe("composition");
    expect(last?.result).toBe("success");
    expect(last?.reason).toBe("need to rework HTML");

    // Persisted on disk.
    const persisted = await readPersistedProject(project.projectId);
    expect(persisted.stage).toBe("composition");
    expect(persisted.stageStatus.composition).toEqual({ status: "pending" });
    expect(persisted.stageStatus.published).toEqual({ status: "pending" });
    expect(persisted.stageHistory.at(-1)?.fromStage).toBe("published");
  });

  it("returns 409 INVALID_TRANSITION when target equals current stage", async () => {
    const project = await seedProject("published");

    const res = await POST(
      buildRequest({ target: "published" }) as unknown as NextRequest,
      { params: Promise.resolve({ id: project.projectId }) },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_TRANSITION");

    // Nothing persisted — stage still published.
    const persisted = await readPersistedProject(project.projectId);
    expect(persisted.stage).toBe("published");
  });

  it("returns 409 INVALID_TRANSITION when target is forward of current stage", async () => {
    const project = await seedEarlyProject("brief");

    const res = await POST(
      buildRequest({ target: "audio" }) as unknown as NextRequest,
      { params: Promise.resolve({ id: project.projectId }) },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_TRANSITION");

    const persisted = await readPersistedProject(project.projectId);
    expect(persisted.stage).toBe("brief");
  });

  it("returns 400 VALIDATION_FAILED for an empty body", async () => {
    const project = await seedProject("published");

    const res = await POST(buildEmptyRequest() as unknown as NextRequest, {
      params: Promise.resolve({ id: project.projectId }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");

    const persisted = await readPersistedProject(project.projectId);
    expect(persisted.stage).toBe("published");
  });
});
