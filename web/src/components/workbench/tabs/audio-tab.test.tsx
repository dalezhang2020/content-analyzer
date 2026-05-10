import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioTab } from "./audio-tab";
import { DEFAULT_VOICE } from "@/lib/workbench/constants";
import type {
  Project,
  Scene,
  Stage,
  StageStatusMap,
} from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_STAGES: readonly Stage[] = [
  "topic",
  "brief",
  "storyboard",
  "composition",
  "audio",
  "render",
  "qa",
  "published",
];

function pendingStageMap(): StageStatusMap {
  const m = {} as StageStatusMap;
  for (const s of ALL_STAGES) m[s] = { status: "pending" };
  return m;
}

function makeScene(overrides: Partial<Scene> & { index: number }): Scene {
  const pad = String(overrides.index).padStart(2, "0");
  return {
    sceneId: `sc_abcd00${pad}`,
    index: overrides.index,
    title: overrides.title ?? `Scene ${overrides.index}`,
    narration: overrides.narration ?? `narration for scene ${overrides.index}`,
    durationSec: overrides.durationSec ?? 5,
    voice: overrides.voice ?? "zh-CN-XiaoxiaoNeural",
    audioPath: overrides.audioPath ?? null,
    qaNote: overrides.qaNote ?? "",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
  };
}

function makeProject(projectId: string, scenes: Scene[]): Project {
  return {
    schemaVersion: 1,
    projectId,
    title: "Test Project",
    topic: "a topic",
    locale: "zh-CN",
    stage: "composition",
    stageStatus: pendingStageMap(),
    stageHistory: [],
    brief: null,
    storyboard: { scenes },
    artifacts: {
      briefPath: null,
      storyboardPath: null,
      compositionDir: "composition",
      indexHtmlPath: "composition/index.html",
      hyperframesJsonPath: null,
      audioPaths: [],
      videoPath: null,
    },
    qaNotes: [],
    templateSource: {
      name: "linear-launch",
      version: "1.0.0",
      sourcePath: "/tmp/templates/linear-launch",
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

/**
 * Tiny router: maps a URL + method to a canned response. Same pattern as
 * html-tab.test.tsx — keeps each test self-contained.
 */
interface FetchHandler {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => unknown;
}

function installFetchMock(handlers: FetchHandler[]) {
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    for (const h of handlers) {
      if (h.match(href, init)) return Promise.resolve(h.respond(href, init));
    }
    return Promise.reject(new Error(`Unhandled fetch: ${href}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------
// Tests — inline player (preserved from T55)
// ---------------------------------------------------------------------------

describe("AudioTab — inline per-scene audio player", () => {
  const projectId = "proj_1700000000000_abc123";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an <audio> element only for scenes with a non-empty audioPath", () => {
    const scenes = [
      makeScene({ index: 1, audioPath: "assets/scene-1.mp3" }),
      makeScene({ index: 2, audioPath: null }),
      makeScene({ index: 3, audioPath: "assets/scene-3.mp3" }),
    ];
    const project = makeProject(projectId, scenes);

    const { container } = render(
      <AudioTab project={project} onProjectChanged={() => {}} />,
    );

    const audios = container.querySelectorAll("audio");
    expect(audios.length).toBe(2);
  });

  it("points each <audio> src at /api/projects/{id}/audio/scenes/{index}", () => {
    const scenes = [
      makeScene({ index: 1, audioPath: "assets/scene-1.mp3" }),
      makeScene({ index: 2, audioPath: null }),
      makeScene({ index: 3, audioPath: "assets/scene-3.mp3" }),
    ];
    const project = makeProject(projectId, scenes);

    const { container } = render(
      <AudioTab project={project} onProjectChanged={() => {}} />,
    );

    const audios = Array.from(container.querySelectorAll("audio"));
    const srcs = audios.map((a) => a.getAttribute("src"));
    // Cache-bust query string `?v={updatedAt}` is appended to force
    // browsers to refetch when the mp3 is regenerated with a new voice.
    expect(srcs).toEqual([
      `/api/projects/${projectId}/audio/scenes/1?v=2024-01-01T00%3A00%3A00.000Z`,
      `/api/projects/${projectId}/audio/scenes/3?v=2024-01-01T00%3A00%3A00.000Z`,
    ]);
  });

  it("sets controls + preload='metadata' + an aria-label on each player", () => {
    const scenes = [makeScene({ index: 1, audioPath: "assets/scene-1.mp3" })];
    const project = makeProject(projectId, scenes);

    const { container } = render(
      <AudioTab project={project} onProjectChanged={() => {}} />,
    );

    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio?.hasAttribute("controls")).toBe(true);
    expect(audio?.getAttribute("preload")).toBe("metadata");
    expect(audio?.getAttribute("aria-label")).toBe("Scene 1 audio");
  });
});

// ---------------------------------------------------------------------------
// Tests — global voice picker
// ---------------------------------------------------------------------------

describe("AudioTab — global voice picker", () => {
  const projectId = "proj_1700000000000_abc123";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getVoiceSelect(): HTMLSelectElement {
    return screen.getByLabelText("Voice") as HTMLSelectElement;
  }

  it("pre-selects the shared scene voice when all scenes agree", () => {
    const sharedVoice = "zh-CN-YunxiNeural";
    const scenes = [
      makeScene({ index: 1, voice: sharedVoice }),
      makeScene({ index: 2, voice: sharedVoice }),
      makeScene({ index: 3, voice: sharedVoice }),
    ];
    const project = makeProject(projectId, scenes);

    render(<AudioTab project={project} onProjectChanged={() => {}} />);

    expect(getVoiceSelect().value).toBe(sharedVoice);
  });

  it("falls back to DEFAULT_VOICE when scenes use mixed voices", () => {
    const scenes = [
      makeScene({ index: 1, voice: "zh-CN-XiaoxiaoNeural" }),
      makeScene({ index: 2, voice: "zh-CN-XiaoxiaoNeural" }),
      makeScene({ index: 3, voice: "zh-CN-YunjianNeural" }),
    ];
    const project = makeProject(projectId, scenes);

    render(<AudioTab project={project} onProjectChanged={() => {}} />);

    expect(getVoiceSelect().value).toBe(DEFAULT_VOICE);
  });

  it("sends exactly one POST to /scenes/bulk-voice and pipes the returned project through onProjectChanged", async () => {
    const scenes = [
      makeScene({ index: 1, voice: "zh-CN-XiaoxiaoNeural" }),
      makeScene({ index: 2, voice: "zh-CN-XiaoxiaoNeural" }),
      makeScene({ index: 3, voice: "zh-CN-YunjianNeural" }),
    ];
    const project = makeProject(projectId, scenes);
    const targetVoice = "zh-CN-YunyangNeural";

    // The response body mirrors the atomic server write: every scene
    // carries the new uniform voice with its audioPath cleared, and
    // `updatedCount` matches the scenes length.
    const refreshed: Project = {
      ...project,
      updatedAt: "2024-01-02T00:00:00.000Z",
      storyboard: {
        scenes: scenes.map((s) => ({
          ...s,
          voice: targetVoice,
          audioPath: null,
        })),
      },
    };

    const fetchMock = installFetchMock([
      {
        match: (url, init) =>
          /\/api\/projects\/[^/]+\/scenes\/bulk-voice$/.test(url) &&
          init?.method === "POST",
        respond: () => ({
          ok: true,
          status: 200,
          json: async () => ({
            project: refreshed,
            updatedCount: scenes.length,
          }),
        }),
      },
    ]);

    const onProjectChanged = vi.fn();
    render(<AudioTab project={project} onProjectChanged={onProjectChanged} />);

    // Select the target voice (a curated voice — no custom input needed).
    fireEvent.change(getVoiceSelect(), { target: { value: targetVoice } });
    expect(getVoiceSelect().value).toBe(targetVoice);

    // Apply → confirm.
    fireEvent.click(
      screen.getByRole("button", { name: "应用到所有场景" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "应用到所有场景？",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认应用" }));

    // Wait for the refetch + callback.
    await waitFor(() => {
      expect(onProjectChanged).toHaveBeenCalledWith(refreshed);
    });

    // Exactly one bulk-voice POST, with the expected body.
    const bulkCalls = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return (
        /\/api\/projects\/[^/]+\/scenes\/bulk-voice$/.test(url) &&
        init?.method === "POST"
      );
    });
    expect(bulkCalls).toHaveLength(1);

    const [url, init] = bulkCalls[0] as [string, RequestInit];
    expect(url).toBe(
      `/api/projects/${projectId}/scenes/bulk-voice`,
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ voice: targetVoice }));

    // Sanity check: the component no longer fans out per-scene PATCH
    // requests (the old race-prone path). Any PATCH against a scene
    // route would be a regression to the fan-out behaviour.
    const patchCalls = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return (
        /\/scenes\/sc_[a-z0-9]{8}$/.test(url) && init?.method === "PATCH"
      );
    });
    expect(patchCalls).toHaveLength(0);

    // Success banner surfaced.
    expect(
      screen.getByRole("status"),
    ).toHaveTextContent(/已将 3 个场景更新为/);

    // Total call count is exactly the single bulk POST — no project
    // GET refetch is needed because the server returns the updated
    // project directly in the response.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reveals a custom voice input under 其他 and sends the typed value", async () => {
    const scenes = [
      makeScene({ index: 1 }),
      makeScene({ index: 2 }),
    ];
    const project = makeProject(projectId, scenes);
    const customVoice = "zh-CN-XiaoyiNeural";

    const refreshed: Project = {
      ...project,
      updatedAt: "2024-01-03T00:00:00.000Z",
      storyboard: {
        scenes: scenes.map((s) => ({
          ...s,
          voice: customVoice,
          audioPath: null,
        })),
      },
    };

    const fetchMock = installFetchMock([
      {
        match: (url, init) =>
          /\/api\/projects\/[^/]+\/scenes\/bulk-voice$/.test(url) &&
          init?.method === "POST",
        respond: () => ({
          ok: true,
          status: 200,
          json: async () => ({
            project: refreshed,
            updatedCount: scenes.length,
          }),
        }),
      },
    ]);

    const onProjectChanged = vi.fn();
    render(<AudioTab project={project} onProjectChanged={onProjectChanged} />);

    // Initially, the custom input is hidden.
    expect(
      screen.queryByLabelText("自定义 Azure voice name"),
    ).not.toBeInTheDocument();

    // Apply button should be disabled before the user picks a value
    // from the empty custom input.
    const applyBtn = screen.getByRole("button", { name: "应用到所有场景" });

    // Switch to custom mode.
    fireEvent.change(getVoiceSelect(), { target: { value: "__custom__" } });

    const customInput = await screen.findByLabelText(
      "自定义 Azure voice name",
    );
    expect(customInput).toBeInTheDocument();

    // With an empty custom value the apply button is disabled.
    expect(applyBtn).toBeDisabled();

    // Type a custom voice.
    fireEvent.change(customInput, { target: { value: customVoice } });
    expect(applyBtn).not.toBeDisabled();

    // Apply → confirm.
    fireEvent.click(applyBtn);
    const dialog = await screen.findByRole("dialog", {
      name: "应用到所有场景？",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认应用" }));

    await waitFor(() => {
      expect(onProjectChanged).toHaveBeenCalledWith(refreshed);
    });

    // Exactly one bulk POST carrying the typed custom value.
    const bulkCalls = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return (
        /\/api\/projects\/[^/]+\/scenes\/bulk-voice$/.test(url) &&
        init?.method === "POST"
      );
    });
    expect(bulkCalls).toHaveLength(1);
    const [, init] = bulkCalls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ voice: customVoice }));
  });
});
