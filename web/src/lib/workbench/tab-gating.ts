// Tab gating helpers for the video creation workbench.
// Pure functions. No side effects. Drive which of the 6 workbench tabs are
// enterable given the project's current Stage.

import { STAGE_ORDER, TAB_MIN_STAGE, type TabName } from "./constants";
import type { Stage } from "./types";

/**
 * The 6 tabs displayed on `/projects/[id]`, in canonical UI order.
 *
 * _Requirements: 12.2, 12.11_
 */
export const TABS = [
  "brief",
  "storyboard",
  "html",
  "audio",
  "render",
  "qa",
] as const satisfies readonly TabName[];

/**
 * Return true iff the project's current `stage` has reached (or passed) the
 * minimum Stage required to enter `tab`, as defined by `TAB_MIN_STAGE`.
 *
 * Uses `STAGE_ORDER` for comparison — never compare `Stage` strings directly.
 *
 * _Requirements: 12.11; Property 22_
 */
export function canEnterTab(tab: TabName, stage: Stage): boolean {
  return STAGE_ORDER[stage] >= STAGE_ORDER[TAB_MIN_STAGE[tab]];
}

/**
 * Return the minimum Stage a project must have reached before `tab`'s
 * controls become enabled.
 *
 * _Requirements: 12.11; Property 22_
 */
export function requiredStageForTab(tab: TabName): Stage {
  return TAB_MIN_STAGE[tab];
}
