/**
 * StageRegressControl test — covers the manual-regress button.
 *
 *   - Renders the button with the expected aria-label and visible copy.
 *   - Clicking opens the confirm dialog.
 *   - Confirming triggers exactly one POST to
 *     `/api/projects/{id}/regress` with `{ target }` and pipes the
 *     returned project through `onRegressed`.
 *   - On a non-2xx response, `onRegressed` is NOT called and an error
 *     message surfaces in the dialog.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StageRegressControl } from "./stage-regress-control";
import { initialStageStatusMap } from "@/lib/workbench/state-machine";
import type { Project } from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const projectId = "proj_1700000000000_abc123";

function makeRefreshedProject(): Project {
  const stageStatus = initialStageStatusMap();
  // Simulate the state after regressing to composition: topic/brief/storyboard
  // preserved as succeeded, composition onwards reset to pending.
  stageStatus.topic = { status: "succeeded", attempts: 1 };
  stageStatus.brief = { status: "succeeded", attempts: 1 };
  stageStatus.storyboard = { status: "succeeded", attempts: 1 };
  return {
    schemaVersion: 1,
    projectId,
    title: "Regressed project",
    topic: "some topic",
    locale: "zh-CN",
    stage: "composition",
    stageStatus,
    stageHistory: [
      {
        fromStage: "published",
        toStage: "composition",
        at: "2024-02-01T00:00:00.000Z",
        result: "success",
      },
    ],
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
      version: "0.0.0-test",
      sourcePath: "/irrelevant",
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-02-01T00:00:00.000Z",
  };
}

interface FetchHandler {
  match: (url: string, init?: RequestInit) => boolean;
  respond: () => unknown;
}

function installFetchMock(handlers: FetchHandler[]) {
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    for (const h of handlers) {
      if (h.match(href, init)) return Promise.resolve(h.respond());
    }
    return Promise.reject(new Error(`Unhandled fetch: ${href}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StageRegressControl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a regress button with the expected label", () => {
    render(
      <StageRegressControl
        projectId={projectId}
        targetStage="composition"
        targetLabel="HTML 场景"
        onRegressed={() => {}}
      />,
    );

    const btn = screen.getByRole("button", {
      name: "回退到 HTML 场景 阶段",
    });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("回退到此阶段");
  });

  it("opens the confirm dialog when the button is clicked", () => {
    render(
      <StageRegressControl
        projectId={projectId}
        targetStage="composition"
        targetLabel="HTML 场景"
        onRegressed={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "回退到 HTML 场景 阶段" }),
    );

    const dialog = screen.getByRole("dialog", { name: "回退到 HTML 场景？" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/HTML 场景/);
    expect(dialog).toHaveTextContent(/状态重置为 pending/);
  });

  it("POSTs to /api/projects/{id}/regress with { target } and pipes the response through onRegressed", async () => {
    const refreshed = makeRefreshedProject();
    const fetchMock = installFetchMock([
      {
        match: (url, init) =>
          url.endsWith("/api/projects/proj_1700000000000_abc123/regress") &&
          init?.method === "POST",
        respond: () => ({
          ok: true,
          status: 200,
          json: async () => refreshed,
        }),
      },
    ]);

    const onRegressed = vi.fn();
    render(
      <StageRegressControl
        projectId={projectId}
        targetStage="composition"
        targetLabel="HTML 场景"
        onRegressed={onRegressed}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "回退到 HTML 场景 阶段" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "回退到 HTML 场景？",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认回退" }));

    await waitFor(() => {
      expect(onRegressed).toHaveBeenCalledWith(refreshed);
    });

    // Exactly one call, shape matches the contract.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/proj_1700000000000_abc123/regress");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ target: "composition" }));
  });

  it("does NOT call onRegressed when the server returns an error; shows the error message", async () => {
    installFetchMock([
      {
        match: (url) =>
          url.endsWith("/api/projects/proj_1700000000000_abc123/regress"),
        respond: () => ({
          ok: false,
          status: 409,
          json: async () => ({
            error: {
              code: "INVALID_TRANSITION",
              message: "Cannot regress to the same stage",
            },
          }),
        }),
      },
    ]);

    const onRegressed = vi.fn();
    render(
      <StageRegressControl
        projectId={projectId}
        targetStage="composition"
        targetLabel="HTML 场景"
        onRegressed={onRegressed}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "回退到 HTML 场景 阶段" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "回退到 HTML 场景？",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认回退" }));

    // Wait for the in-flight fetch to settle, then assert the callback
    // was never invoked and an error notice is visible.
    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toBeInTheDocument();
    });
    expect(onRegressed).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      /INVALID_TRANSITION/,
    );
  });
});
