/**
 * HtmlTab test — covers the scene grid + preview drawer added in T55.
 *
 * Three assertions:
 *   1. With `stage === "composition"` and a mix of ready / missing
 *      scenes, the grid renders one card per storyboard scene with
 *      correct status chips.
 *   2. Clicking "点击预览" on a ready card opens a drawer containing an
 *      iframe pointed at the scene endpoint with `sandbox="allow-scripts"`.
 *   3. While `stageStatus.composition.status === "running"`, missing
 *      scenes show "生成中" (not "待生成" / "失败").
 *   4. The existing "重新生成 HTML" confirm-dialog flow still works.
 *
 * Polling-interval behaviour is documented in `_scene-grid.tsx`
 * (`setInterval(2000)` while composition is running). We do NOT
 * fake-timer assert the interval because it would entangle with the
 * initial-mount fetch's Promise microtasks and add flakiness without
 * meaningfully covering the contract — the code path is a 4-line
 * effect and the functional behaviour is covered by assertion 3.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { HtmlTab } from "./html-tab";
import { initialStageStatusMap } from "@/lib/workbench/state-machine";
import type { Project, Scene, StageStatusValue } from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeScene(overrides: Partial<Scene>): Scene {
  return {
    sceneId: "sc_00000001",
    index: 1,
    title: "Scene",
    narration: "Test narration",
    durationSec: 5,
    voice: "zh-CN-Xiaochen:DragonHDFlashLatestNeural",
    audioPath: null,
    qaNote: "",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface ProjectOpts {
  compositionStatus?: StageStatusValue;
  scenes?: Scene[];
}

function makeProject({
  compositionStatus = "succeeded",
  scenes,
}: ProjectOpts = {}): Project {
  const stageStatus = initialStageStatusMap();
  stageStatus.composition = {
    ...stageStatus.composition,
    status: compositionStatus,
  };
  return {
    schemaVersion: 1,
    projectId: "proj_1700000000000_abc123",
    title: "Test Project",
    topic: "Test topic",
    locale: "zh-CN",
    stage: "composition",
    stageStatus,
    stageHistory: [],
    brief: null,
    storyboard: {
      scenes: scenes ?? [
        makeScene({ sceneId: "sc_00000001", index: 1, title: "Intro" }),
        makeScene({ sceneId: "sc_00000002", index: 2, title: "Middle" }),
        makeScene({ sceneId: "sc_00000003", index: 3, title: "Outro" }),
      ],
    },
    artifacts: {
      briefPath: null,
      storyboardPath: "storyboard.json",
      compositionDir: "composition",
      indexHtmlPath: "composition/index.html",
      hyperframesJsonPath: "composition/hyperframes.json",
      audioPaths: [],
      videoPath: null,
    },
    qaNotes: [],
    templateSource: {
      name: "linear-launch",
      version: "0.0.0-test",
      sourcePath: "/irrelevant",
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

interface SceneStatusFixture {
  sceneId: string;
  index: number;
  title: string;
  compositionId: string;
  relPath: string;
  exists: boolean;
  size: number;
  updatedAt?: string;
}

function scenesPayload(entries: SceneStatusFixture[]) {
  return {
    ok: true,
    json: async () => ({ scenes: entries }),
  };
}

function htmlPayload(text: string) {
  return {
    ok: true,
    text: async () => text,
  };
}

/**
 * Tiny router that serves different payloads per URL prefix. Keeps each
 * test self-contained without forcing `mockResolvedValueOnce` chains.
 */
function installFetchMock(handlers: Array<{
  match: (url: string) => boolean;
  respond: () => unknown;
}>) {
  const fetchMock = vi.fn((url: string | URL, _init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    for (const h of handlers) {
      if (h.match(href)) return Promise.resolve(h.respond());
    }
    return Promise.reject(new Error(`Unhandled fetch: ${href}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HtmlTab — scene grid", () => {
  beforeEach(() => {
    // Silence unhandled rejections from in-flight fetches during unmount.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders one card per storyboard scene with correct status chips", async () => {
    const project = makeProject();
    installFetchMock([
      {
        match: (u) => u.endsWith("/composition/scenes"),
        respond: () =>
          scenesPayload([
            {
              sceneId: "sc_00000001",
              index: 1,
              title: "Intro",
              compositionId: "scene-01-000000",
              relPath: "compositions/scene-01-000000.html",
              exists: true,
              size: 2048,
              updatedAt: "2024-01-02T00:00:00.000Z",
            },
            {
              sceneId: "sc_00000002",
              index: 2,
              title: "Middle",
              compositionId: "scene-02-000000",
              relPath: "compositions/scene-02-000000.html",
              exists: true,
              size: 4096,
              updatedAt: "2024-01-02T00:00:00.000Z",
            },
            {
              sceneId: "sc_00000003",
              index: 3,
              title: "Outro",
              compositionId: "scene-03-000000",
              relPath: "compositions/scene-03-000000.html",
              exists: false,
              size: 0,
            },
          ]),
      },
      {
        match: (u) => u.endsWith("/composition/html"),
        respond: () => htmlPayload("<html></html>"),
      },
    ]);

    render(<HtmlTab project={project} />);

    // Wait for the /scenes fetch to resolve and the cards to render.
    await waitFor(() => {
      expect(screen.getByTestId("scene-card-1")).toHaveAttribute(
        "data-status",
        "ready",
      );
    });
    expect(screen.getByTestId("scene-card-2")).toHaveAttribute(
      "data-status",
      "ready",
    );
    expect(screen.getByTestId("scene-card-3")).toHaveAttribute(
      "data-status",
      "pending",
    );

    // Status chip copy.
    expect(
      within(screen.getByTestId("scene-card-1")).getByText("已生成"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("scene-card-3")).getByText("待生成"),
    ).toBeInTheDocument();

    // File size rendering: 2048 bytes → 2 KB, missing → "—".
    expect(
      within(screen.getByTestId("scene-card-1")).getByText("2 KB"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("scene-card-3")).getByText("—"),
    ).toBeInTheDocument();
  });

  it("opens the preview drawer with a sandboxed iframe when a ready card is clicked", async () => {
    const project = makeProject();
    installFetchMock([
      {
        match: (u) => u.endsWith("/composition/scenes"),
        respond: () =>
          scenesPayload([
            {
              sceneId: "sc_00000001",
              index: 1,
              title: "Intro",
              compositionId: "scene-01-abc123",
              relPath: "compositions/scene-01-abc123.html",
              exists: true,
              size: 3072,
              updatedAt: "2024-01-02T00:00:00.000Z",
            },
            {
              sceneId: "sc_00000002",
              index: 2,
              title: "Middle",
              compositionId: "scene-02-def456",
              relPath: "compositions/scene-02-def456.html",
              exists: false,
              size: 0,
            },
            {
              sceneId: "sc_00000003",
              index: 3,
              title: "Outro",
              compositionId: "scene-03-ghi789",
              relPath: "compositions/scene-03-ghi789.html",
              exists: false,
              size: 0,
            },
          ]),
      },
      {
        match: (u) => u.endsWith("/composition/html"),
        respond: () => htmlPayload("<html></html>"),
      },
    ]);

    render(<HtmlTab project={project} />);

    // Wait for the grid to populate.
    const card1 = await screen.findByTestId("scene-card-1");
    const previewBtn = within(card1).getByRole("button", {
      name: /Preview scene 1/i,
    });
    expect(previewBtn).not.toBeDisabled();

    fireEvent.click(previewBtn);

    const iframe = await screen.findByTestId("scene-preview-iframe");
    expect(iframe).toHaveAttribute(
      "src",
      "/api/projects/proj_1700000000000_abc123/composition/scenes/scene-01-abc123",
    );
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    expect(iframe).toHaveAttribute("title", "Scene 1 preview");
  });

  it("shows 生成中 for missing scenes while composition is running", async () => {
    const project = makeProject({ compositionStatus: "running" });
    installFetchMock([
      {
        match: (u) => u.endsWith("/composition/scenes"),
        respond: () =>
          scenesPayload([
            {
              sceneId: "sc_00000001",
              index: 1,
              title: "Intro",
              compositionId: "scene-01-000000",
              relPath: "compositions/scene-01-000000.html",
              exists: true,
              size: 1024,
              updatedAt: "2024-01-02T00:00:00.000Z",
            },
            {
              sceneId: "sc_00000002",
              index: 2,
              title: "Middle",
              compositionId: "scene-02-000000",
              relPath: "compositions/scene-02-000000.html",
              exists: false,
              size: 0,
            },
            {
              sceneId: "sc_00000003",
              index: 3,
              title: "Outro",
              compositionId: "scene-03-000000",
              relPath: "compositions/scene-03-000000.html",
              exists: false,
              size: 0,
            },
          ]),
      },
      {
        match: (u) => u.endsWith("/composition/html"),
        respond: () => htmlPayload("<html></html>"),
      },
    ]);

    render(<HtmlTab project={project} />);

    const card1 = await screen.findByTestId("scene-card-1");
    expect(card1).toHaveAttribute("data-status", "ready");

    const card2 = await screen.findByTestId("scene-card-2");
    expect(card2).toHaveAttribute("data-status", "generating");
    expect(within(card2).getByText("生成中")).toBeInTheDocument();

    const card3 = await screen.findByTestId("scene-card-3");
    expect(card3).toHaveAttribute("data-status", "generating");

    // Preview button should still be disabled on missing scenes.
    expect(
      within(card2).getByRole("button", { name: /Preview scene 2/i }),
    ).toBeDisabled();
  });

  it("preserves the 重新生成 HTML confirm-dialog flow", async () => {
    const project = makeProject();
    const updatedProject = { ...project, updatedAt: "2024-02-01T00:00:00.000Z" };

    const fetchMock = installFetchMock([
      {
        match: (u) => u.endsWith("/composition/scenes"),
        respond: () => scenesPayload([]),
      },
      {
        match: (u) => u.endsWith("/composition/html"),
        respond: () => htmlPayload("<html></html>"),
      },
      {
        match: (u) => u.endsWith("/composition/generate"),
        respond: () => ({
          ok: true,
          json: async () => updatedProject,
        }),
      },
    ]);

    const onProjectChanged = vi.fn();
    render(<HtmlTab project={project} onProjectChanged={onProjectChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "重新生成 HTML" }));

    // Confirm dialog appears.
    const dialog = await screen.findByRole("dialog", {
      name: "重新生成 HTML？",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "确认重新生成" }),
    );

    await waitFor(() => {
      expect(onProjectChanged).toHaveBeenCalledWith(updatedProject);
    });

    // Verify the POST went to the generate endpoint with force=true.
    const generateCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith("/composition/generate"),
    );
    expect(generateCall).toBeDefined();
    const init = generateCall?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ force: true }));
  });
});
