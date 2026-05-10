// Tab gating helpers for the video creation workbench.
// Pure functions. No side effects. Drive which of the 6 workbench tabs are
// enterable given the project's current Stage.

import { STAGE_ORDER, TAB_MIN_STAGE, type TabName } from "./constants";
import type { Stage } from "./types";

/**
 * The 5 tabs displayed on `/projects/[id]`, in canonical UI order.
 */
export const TABS = [
  "brief",
  "storyboard",
  "html",
  "audio",
  "render",
] as const satisfies readonly TabName[];

/**
 * Return true iff the project's current `stage` has reached (or passed) the
 * minimum Stage required to enter `tab`, as defined by `TAB_MIN_STAGE`.
 *
 * Uses `STAGE_ORDER` for comparison — never compare `Stage` strings directly.
 */
export function canEnterTab(tab: TabName, stage: Stage): boolean {
  return STAGE_ORDER[stage] >= STAGE_ORDER[TAB_MIN_STAGE[tab]];
}

/**
 * Return the minimum Stage a project must have reached before `tab`'s
 * controls become enabled.
 */
export function requiredStageForTab(tab: TabName): Stage {
  return TAB_MIN_STAGE[tab];
}
