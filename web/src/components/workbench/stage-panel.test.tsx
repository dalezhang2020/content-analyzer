/**
 * StagePanel test — covers the optional manual-regress integration.
 *
 *   - Renders all 8 stage rows in canonical order.
 *   - When `projectId` + `onProjectRegressed` are supplied, each row
 *     with `STAGE_ORDER < STAGE_ORDER[currentStage]` grows a regress
 *     button; later/current rows do NOT.
 *   - When the props are absent, no regress buttons render at all.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StagePanel } from "./stage-panel";
import { initialStageStatusMap } from "@/lib/workbench/state-machine";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StagePanel — regress button visibility", () => {
  const projectId = "proj_1700000000000_abc123";

  it("renders regress buttons only for stages strictly earlier than the current stage", () => {
    const stageStatus = initialStageStatusMap();

    render(
      <StagePanel
        stages={stageStatus}
        currentStage="published"
        projectId={projectId}
        onProjectRegressed={() => {}}
      />,
    );

    // All 7 non-current stages should have a regress control when
    // currentStage === published (the last stage in STAGE_ORDER).
    const expectedLabels = [
      "选题",
      "内容卡",
      "分镜",
      "HTML 场景",
      "音频",
      "渲染",
      "QA",
    ];
    for (const label of expectedLabels) {
      expect(
        screen.getByRole("button", { name: `回退到 ${label} 阶段` }),
      ).toBeInTheDocument();
    }

    // Current stage (published) has no regress button — nothing to
    // regress to from itself.
    expect(
      screen.queryByRole("button", { name: /回退到 已发布/ }),
    ).not.toBeInTheDocument();
  });

  it("renders no regress buttons when currentStage is the first stage (topic)", () => {
    const stageStatus = initialStageStatusMap();

    render(
      <StagePanel
        stages={stageStatus}
        currentStage="topic"
        projectId={projectId}
        onProjectRegressed={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /回退到 .* 阶段/ })).toBeNull();
  });

  it("renders no regress buttons when projectId / onProjectRegressed are not supplied", () => {
    const stageStatus = initialStageStatusMap();

    render(<StagePanel stages={stageStatus} currentStage="published" />);

    expect(screen.queryByRole("button", { name: /回退到/ })).toBeNull();
  });

  it("renders regress buttons only for stages before the current stage (composition case)", () => {
    const stageStatus = initialStageStatusMap();

    render(
      <StagePanel
        stages={stageStatus}
        currentStage="composition"
        projectId={projectId}
        onProjectRegressed={() => {}}
      />,
    );

    // topic / brief / storyboard → regress available.
    for (const label of ["选题", "内容卡", "分镜"]) {
      expect(
        screen.getByRole("button", { name: `回退到 ${label} 阶段` }),
      ).toBeInTheDocument();
    }
    // composition (current) + audio / render / qa / 已发布 → no
    // regress available.
    for (const label of ["HTML 场景", "音频", "渲染", "QA", "已发布"]) {
      expect(
        screen.queryByRole("button", { name: `回退到 ${label} 阶段` }),
      ).toBeNull();
    }
  });
});
