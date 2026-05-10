/**
 * Video Creation Workbench — tab-gating property tests (T15.2).
 *
 * Verifies that `canEnterTab(tab, stage)` returns `true` iff the project's
 * current stage has reached (or passed) the tab's minimum stage per
 * `TAB_MIN_STAGE`, using `STAGE_ORDER` for comparison.
 *
 * _Validates: Requirements 12.11_
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { STAGES, STAGE_ORDER, TAB_MIN_STAGE, type TabName } from "./constants";
import { TABS, canEnterTab } from "./tab-gating";
import type { Stage } from "./types";

// Feature: video-creation-workbench, Property 22: Tab gating matches the stage-to-tab map

describe("tab-gating", () => {
  it("Property 22: canEnterTab(tab, stage) iff STAGE_ORDER[stage] >= STAGE_ORDER[minStage(tab)]", () => {
    const tabArb = fc.constantFrom<TabName>(...TABS);
    const stageArb = fc.constantFrom<Stage>(...STAGES);

    fc.assert(
      fc.property(tabArb, stageArb, (tab, stage) => {
        const expected =
          STAGE_ORDER[stage] >= STAGE_ORDER[TAB_MIN_STAGE[tab]];
        expect(canEnterTab(tab, stage)).toBe(expected);
      }),
    );
  });

  it("documented map: Brief≥brief, Storyboard≥storyboard, HTML/Audio≥composition, Render≥audio", () => {
    // Sanity check that the map itself matches the design doc.
    expect(TAB_MIN_STAGE).toEqual({
      brief: "brief",
      storyboard: "storyboard",
      html: "composition",
      audio: "composition",
      render: "audio",
    });
  });
});
