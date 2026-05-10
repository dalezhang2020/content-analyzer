/**
 * Video Creation Workbench — `POST /api/projects/{id}/composition/generate`.
 *
 * Generates (or regenerates, via `force: true`) the project's HyperFrames
 * HTML composition from `project.storyboard`.
 *
 * **Architecture — Plan A: scene-sharded generation.**
 *
 * Rather than asking the LLM to produce one monolithic ~15 KB HTML
 * document covering all scenes (which hit token-cap truncation and LLM
 * timeout on complex storyboards), we split the work:
 *
 *   1. For each scene, one small LLM call produces a HyperFrames
 *      sub-composition file (`<template id="…-template">…</template>`,
 *      ~1–5 KB). Single-scene output is small enough that token cap and
 *      model timeout never matter.
 *
 *   2. The parent `index.html` is assembled by deterministic code
 *      (`assembleIndexHtml`) — no LLM involvement. It just stitches
 *      `data-composition-src` references with cumulative `data-start`.
 *
 *   3. Per-scene repair retry: if one scene fails lint/validate after
 *      assembly, we identify the offending file from the stderr and
 *      retry only that scene. Other scenes stay on disk.
 *
 * Flow:
 *   1. Validate path param via `requireProjectIdFromParams`.
 *   2. Read optional `{ force?: boolean }` body.
 *   3. Stage guard: `storyboard` with no existing indexHtml, OR `force`.
 *   4. Storyboard presence check.
 *   5. `markStageRunning("composition")`.
 *   6. `clearSceneCompositions(projectId)` — wipe stale scene files from
 *      previous runs before regenerating.
 *   7. For each scene (sequentially, not parallel — each LLM call is
 *      already slow, and running 11 in parallel would hammer credits):
 *        a. `generateSceneCompositionHtml(project, scene)`
 *        b. `scanHtml(html)` for forbidden tokens
 *        c. `writeSceneCompositionHtml(projectId, scenePath, html)`
 *   8. `assembleIndexHtml(project)` → `writeCompositionHtml(projectId, …)`.
 *   9. Run `hyperframes lint` + `validate` on the full composition dir.
 *  10. On lint/validate failure, identify the offending scene (parse
 *      stderr for `scene-NN-xxx.html` mention) and regenerate ONLY that
 *      scene once. Re-assemble index.html. Re-run lint/validate.
 *  11. On final failure, snapshot the offending scene HTML as
 *      `{scenePath}.failed.bak` for inspection.
 *  12. On success: update artifacts, markStageSucceeded, transition to
 *      `composition`.
 *
 * _Requirements: 6.1–6.8, 16.7_
 */

import type { NextRequest } from "next/server";
import pLimit from "p-limit";

import {
  assembleIndexHtml,
  generateSceneCompositionHtml,
  sceneCompositionId,
  sceneCompositionPath,
} from "@/lib/workbench/ai-generator";
import {
  parseJsonBody,
  requireProjectIdFromParams,
  respondError,
  respondJson,
} from "@/lib/workbench/api-helpers";
import { atomicWriteBuffer } from "@/lib/workbench/atomic-fs";
import {
  LIMITS,
  SCENE_GEN_CONCURRENCY_DEFAULT,
  STAGE_DIRS,
} from "@/lib/workbench/constants";
import { ErrorCode, WorkbenchError } from "@/lib/workbench/errors";
import { scanHtml } from "@/lib/workbench/html-scanner";
import { withProjectLock } from "@/lib/workbench/locks";
import { resolveProjectFile } from "@/lib/workbench/path-safety";
import {
  clearSceneCompositions,
  readProject,
  writeCompositionHtml,
  writeProject,
  writeSceneCompositionHtml,
} from "@/lib/workbench/project-store";
import {
  runHyperframesLint,
  runHyperframesValidate,
} from "@/lib/workbench/render-service";
import { ForceFlagSchema } from "@/lib/workbench/schemas";
import {
  applyTransition,
  markStageFailed,
  markStageRunning,
  markStageSucceeded,
} from "@/lib/workbench/state-machine";
import type { Project, Scene } from "@/lib/workbench/types";

/** Max characters of stderr surfaced back in the 502 response. _Req 6.7_ */
const STDERR_MAX = 4000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function lintAndValidate(
  projectId: string,
): Promise<{ ok: boolean; stderr: string; failedCmd: "lint" | "validate" | null }> {
  const lint = await runHyperframesLint(projectId);
  if (!lint.ok) {
    return { ok: false, stderr: lint.stderr, failedCmd: "lint" };
  }
  const validate = await runHyperframesValidate(projectId);
  if (!validate.ok) {
    return { ok: false, stderr: validate.stderr, failedCmd: "validate" };
  }
  return { ok: true, stderr: "", failedCmd: null };
}

/**
 * Preserve a failed sub-composition HTML as a `.bak` sibling so humans
 * can inspect what the LLM produced. The `.bak` suffix keeps hyperframes
 * lint from discovering it as a second root composition on the next run.
 */
async function preserveFailedScene(
  projectId: string,
  scenePath: string,
  html: string,
): Promise<void> {
  try {
    const parts = scenePath.split("/").filter(Boolean);
    const failedPath = resolveProjectFile(
      projectId,
      STAGE_DIRS.COMPOSITION,
      ...parts.slice(0, -1),
      parts[parts.length - 1] + ".bak",
    );
    await atomicWriteBuffer(failedPath, Buffer.from(html, "utf8"));
  } catch {
    // Swallow — the primary failure is what the caller needs to see.
  }
}

/**
 * Parse a lint/validate stderr dump for a scene file path of the form
 * `compositions/scene-NN-xxxxxx.html` and return the scene it refers to.
 * Returns `null` when no scene reference is found (e.g. validate reports a
 * runtime error that can't be pinned to a single scene).
 */
function findOffendingScene(stderr: string, scenes: readonly Scene[]): Scene | null {
  // Build a map of every scene's canonical file name so we can scan
  // stderr in one pass — cheaper than a regex per scene.
  const byFilename = new Map<string, Scene>();
  for (const s of scenes) {
    // `compositions/scene-NN-xxxxxx.html` — strip the dir prefix so we
    // match both bare filenames and full paths in stderr.
    const p = sceneCompositionPath(s);
    byFilename.set(p, s);
    const bare = p.replace(/^compositions\//, "");
    byFilename.set(bare, s);
  }

  for (const [name, scene] of byFilename) {
    if (stderr.includes(name)) return scene;
  }
  return null;
}

/**
 * Generate every scene's sub-composition HTML via bounded-concurrent LLM
 * calls (default 4, overridable via `SCENE_GEN_CONCURRENCY`). Stale scene
 * files from a previous run are wiped first.
 *
 * Error semantics: if any single scene fails its forbidden-token scan or
 * the underlying LLM call throws, the whole batch rejects. We use
 * `Promise.allSettled` internally so every in-flight request finishes (or
 * gets cancelled by timeout) before we throw, preventing orphan kiro-cli
 * subprocesses from leaking after a partial failure.
 *
 * The error surfaced preserves the FIRST scene failure encountered,
 * matching the previous serial loop's "fail-fast on scene N" behaviour.
 */
/**
 * Invoke `generateSceneCompositionHtml` with up to `maxRetries` retries on
 * `LLM_TIMEOUT` errors. Other errors propagate immediately (we only retry
 * transient failures, not schema violations or permission errors).
 *
 * Each retry uses the same prompt (no `lintError` is supplied) — the
 * hypothesis is that a timeout is a server-side cold-start / slowness
 * issue rather than a prompt-quality issue. If that hypothesis is wrong
 * the route-level repair loop downstream will catch genuine bad output.
 */
async function generateSceneWithRetry(
  project: Project,
  scene: Scene,
  context: { prevNarration?: string; nextNarration?: string },
  maxRetries: number,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await generateSceneCompositionHtml(project, scene, { context });
    } catch (err) {
      lastErr = err;
      const isTimeout =
        err instanceof WorkbenchError && err.code === ErrorCode.LLM_TIMEOUT;
      if (!isTimeout || attempt === maxRetries) {
        throw err;
      }
      // Brief back-off before the next attempt — the upstream server is
      // often slow on cold start but recovers quickly. We cap at 2s so
      // we don't blow the wall-clock budget.
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  // Unreachable — the loop either returns or throws — but TS wants a
  // throw on all paths.
  throw lastErr;
}

async function generateAllScenes(project: Project): Promise<void> {
  if (!project.storyboard) return;
  const scenes = project.storyboard.scenes;

  await clearSceneCompositions(project.projectId);

  const concurrency = parseConcurrency(process.env.SCENE_GEN_CONCURRENCY);
  const limit = pLimit(concurrency);

  const tasks = scenes.map((scene, i) =>
    limit(async () => {
      const prev = i > 0 ? scenes[i - 1].narration : undefined;
      const next =
        i + 1 < scenes.length ? scenes[i + 1].narration : undefined;

      // Up to 2 retries on LLM_TIMEOUT — Opus occasionally cold-starts
      // at 180s on the first call of a batch but completes in 30-60s on
      // retry. Retrying makes a 10%-ish slowdown on the tail without
      // failing the whole composition for one slow scene.
      const html = await generateSceneWithRetry(
        project,
        scene,
        { prevNarration: prev, nextNarration: next },
        2,
      );

      const scan = scanHtml(html);
      if (!scan.ok) {
        throw new WorkbenchError(
          ErrorCode.LLM_OUTPUT_INVALID,
          `Scene ${scene.index} returned forbidden token: ${scan.hit}`,
          { sceneId: scene.sceneId, hit: scan.hit },
        );
      }

      await writeSceneCompositionHtml(
        project.projectId,
        sceneCompositionPath(scene),
        html,
      );
    }),
  );

  const results = await Promise.allSettled(tasks);

  // Surface the first rejection; any successfully-written scenes stay on
  // disk (they'll be overwritten by the next attempt or kept if the
  // user decides to regenerate only the failing scene later).
  for (const r of results) {
    if (r.status === "rejected") {
      throw r.reason instanceof Error
        ? r.reason
        : new WorkbenchError(
            ErrorCode.LLM_OUTPUT_INVALID,
            String(r.reason),
          );
    }
  }
}

/**
 * Parse the optional `SCENE_GEN_CONCURRENCY` env override into a positive
 * integer, clamping to `[1, 12]`. Falls back to the compiled default on
 * missing / malformed input.
 */
function parseConcurrency(raw: string | undefined): number {
  if (!raw) return SCENE_GEN_CONCURRENCY_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return SCENE_GEN_CONCURRENCY_DEFAULT;
  return Math.min(n, 12);
}

/**
 * Regenerate a single scene's sub-composition with lint-error context,
 * then rewrite its file. Returns the HTML so the caller can keep it in
 * memory for `.bak` preservation on a second failure.
 */
async function repairOneScene(
  project: Project,
  scene: Scene,
  lintError: string,
): Promise<string> {
  const scenes = project.storyboard?.scenes ?? [];
  const idx = scenes.findIndex((s) => s.sceneId === scene.sceneId);
  const prev = idx > 0 ? scenes[idx - 1].narration : undefined;
  const next = idx >= 0 && idx + 1 < scenes.length ? scenes[idx + 1].narration : undefined;

  const html = await generateSceneCompositionHtml(project, scene, {
    lintError,
    context: { prevNarration: prev, nextNarration: next },
  });
  const scan = scanHtml(html);
  if (!scan.ok) {
    await preserveFailedScene(
      project.projectId,
      sceneCompositionPath(scene),
      html,
    );
    throw new WorkbenchError(
      ErrorCode.LLM_OUTPUT_INVALID,
      `Scene ${scene.index} repair returned forbidden token: ${scan.hit}`,
      { sceneId: scene.sceneId, hit: scan.hit },
    );
  }
  await writeSceneCompositionHtml(
    project.projectId,
    sceneCompositionPath(scene),
    html,
  );
  return html;
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const projectId = await requireProjectIdFromParams(ctx.params);
    const body = await parseJsonBody(req, ForceFlagSchema, {
      maxBytes: LIMITS.REQUEST_BODY_MAX_BYTES_GEN,
    }).catch(() => ({}) as { force?: boolean });
    const force = body.force ?? false;

    const updated = await withProjectLock(projectId, async () => {
      let project = await readProject(projectId);

      // Stage guard — same semantics as the pre-refactor route.
      if (
        project.stage === "storyboard" &&
        !project.artifacts.indexHtmlPath
      ) {
        // fresh first run
      } else if (force) {
        // explicit overwrite
      } else {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Composition already generated or Storyboard not ready",
          {
            currentStage: project.stage,
            hasIndexHtml: project.artifacts.indexHtmlPath !== null,
          },
        );
      }

      if (!project.storyboard || project.storyboard.scenes.length === 0) {
        throw new WorkbenchError(
          ErrorCode.INVALID_STAGE,
          "Storyboard required before composition",
          { currentStage: project.stage },
        );
      }

      project = markStageRunning(project, "composition");
      // Persist the `running` status immediately so the HTML tab's scene
      // grid (which polls every 2s while status === "running") sees
      // per-scene files land on disk as they're generated. Without this
      // write the grid stays idle on the stale "pending" until the whole
      // ~10min regen finishes, which defeats the whole streaming UX.
      await writeProject(project);
      try {
        // ---- Phase 1: generate every scene sub-composition ----------
        await generateAllScenes(project);

        // ---- Phase 2: assemble the parent index.html ---------------
        let indexHtml = assembleIndexHtml(project);
        // scanHtml on index.html — it's deterministic but belt-and-braces.
        const indexScan = scanHtml(indexHtml);
        if (!indexScan.ok) {
          throw new WorkbenchError(
            ErrorCode.LLM_OUTPUT_INVALID,
            `Assembled index.html contained forbidden token: ${indexScan.hit}`,
            { hit: indexScan.hit },
          );
        }
        await writeCompositionHtml(projectId, indexHtml);

        // ---- Phase 3: lint + validate across all files --------------
        let check = await lintAndValidate(projectId);

        // ---- Phase 4: per-scene repair retry on failure ------------
        if (!check.ok) {
          const offending = findOffendingScene(
            check.stderr,
            project.storyboard.scenes,
          );
          if (offending) {
            // Re-generate just this one scene with lint feedback.
            await repairOneScene(project, offending, check.stderr);
            // Parent index.html already references the right path; no
            // need to re-assemble unless scene IDs changed (they don't).
            check = await lintAndValidate(projectId);
          }

          if (!check.ok) {
            // Final failure — preserve for inspection.
            if (offending) {
              const scenePath = sceneCompositionPath(offending);
              try {
                const { readFile } = await import("node:fs/promises");
                const abs = resolveProjectFile(
                  projectId,
                  STAGE_DIRS.COMPOSITION,
                  ...scenePath.split("/").filter(Boolean),
                );
                const disk = await readFile(abs, "utf8");
                await preserveFailedScene(projectId, scenePath, disk);
              } catch {
                // best-effort — skip .bak on read failure
              }
            }

            const truncatedStderr = check.stderr.slice(0, STDERR_MAX);
            const code =
              check.failedCmd === "lint"
                ? ErrorCode.LINT_FAILED
                : ErrorCode.VALIDATE_FAILED;
            throw new WorkbenchError(code, truncatedStderr, {
              stderr: truncatedStderr,
              failedCmd: check.failedCmd,
              offendingScene: offending
                ? sceneCompositionId(offending)
                : null,
            });
          }

          // Re-read index in case the repair regenerated it — actually
          // the current implementation doesn't touch index.html during
          // repair (scene IDs are stable), so this is a no-op today.
          // Kept for clarity if we ever add per-repair reassembly.
          indexHtml = await (async () => {
            // placeholder — no-op refresh
            return indexHtml;
          })();
        }

        // ---- Success -----------------------------------------------
        project = {
          ...project,
          artifacts: {
            ...project.artifacts,
            indexHtmlPath: "composition/index.html",
            compositionDir: "composition",
            hyperframesJsonPath: "composition/hyperframes.json",
          },
        };
        project = markStageSucceeded(project, "composition");
        if (project.stage === "storyboard") {
          project = applyTransition(project, "composition");
        }
        await writeProject(project);
        return project;
      } catch (err) {
        const code =
          err instanceof WorkbenchError
            ? err.code
            : ErrorCode.LLM_OUTPUT_INVALID;
        const message = err instanceof Error ? err.message : String(err);
        project = markStageFailed(project, "composition", { code, message });
        await writeProject(project);
        throw err;
      }
    });

    return respondJson(updated);
  } catch (e) {
    return respondError(e);
  }
}
