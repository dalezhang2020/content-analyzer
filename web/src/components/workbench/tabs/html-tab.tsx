"use client";

/**
 * HtmlTab — read-only source viewer for the composition's `index.html`.
 *
 * Fetches the raw bytes from
 * `GET /api/projects/{id}/composition/html` on mount (and whenever
 * the project's composition artifact pointer changes — a regen will
 * flip `project.updatedAt` so the effect re-runs).
 *
 * Actions:
 *   - "在浏览器预览" — opens the raw HTML URL in a new tab.
 *   - "重新生成 HTML" — POST `.../composition/generate` with
 *     `{ force: true }` after a confirmation dialog. Audio artifacts
 *     may be invalidated by a regen.
 *
 * Scene grid (added in T55):
 *   - Rendered above the raw-source viewer when the project has
 *     reached `composition` stage OR is currently generating one
 *     (`stageStatus.composition.status === "running"`).
 *   - Polls `/composition/scenes` every 2 s while generation is in
 *     flight and lets the user click a ready scene to preview it in
 *     an iframe drawer (see `_scene-grid.tsx` for sandbox rationale).
 *
 * Note: this tab is read-only w.r.t. the HTML content itself. Manual
 * HTML editing is a separate future-work affordance (surface area too
 * wide for MVP).
 *
 * _Requirements: 12.5, 12.11, 12.12, 16.7, 17.2_
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { StageFailureBanner } from "@/components/workbench/stage-failure-banner";
import { SceneGrid } from "@/components/workbench/tabs/_scene-grid";
import {
  ConfirmDialog,
  EmptyStateCard,
  extractErrorMessage,
} from "@/components/workbench/tabs/_shared";
import { STAGE_ORDER } from "@/lib/workbench/constants";
import { canEnterTab, requiredStageForTab } from "@/lib/workbench/tab-gating";
import type { Project } from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface HtmlTabProps {
  project: Project;
  onProjectChanged?: (project: Project) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HtmlTab({
  project,
  onProjectChanged,
}: HtmlTabProps): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const canEnter = canEnterTab("html", project.stage);

  const generate = useCallback(async (force = false) => {
    setGenerating(true);
    setActionError(null);
    // Close the confirm dialog immediately and let the scene grid's
    // polling loop reflect progress. The POST can take 5-15 minutes
    // (one LLM call per scene, each up to 180s, plus retries) — blocking
    // a modal spinner on the whole trip defeats the streaming UX.
    // If the request ultimately fails we surface the error via the
    // actionError banner, which remains visible after the dialog closes.
    if (force) setConfirmOpen(false);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.projectId)}/composition/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        },
      );
      if (!res.ok) {
        const msg = await extractErrorMessage(res, force ? "重新生成失败" : "生成失败");
        setActionError(msg);
        return;
      }
      const updated = (await res.json()) as Project;
      onProjectChanged?.(updated);
      if (!force) setConfirmOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  }, [project.projectId, onProjectChanged]);

  // stage=storyboard: show "generate HTML" CTA (first-time generation
  // is what advances storyboard → composition).
  if (project.stage === "storyboard") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-12 text-center">
        <p className="text-sm font-medium text-foreground">
          点击下方按钮，AI 将根据分镜生成 HyperFrames HTML 场景
        </p>
        <p className="text-xs text-muted-foreground">
          共 {project.storyboard?.scenes.length ?? 0} 个场景
        </p>
        {actionError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {actionError}
          </div>
        ) : null}
        <Button
          type="button"
          onClick={() => void generate(false)}
          disabled={generating}
        >
          {generating ? "生成中…" : "生成 HTML"}
        </Button>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Fetch HTML on mount (and whenever the composition artifact changes).
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!canEnter) return;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    (async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(project.projectId)}/composition/html`,
          { method: "GET" },
        );
        if (!res.ok) {
          const msg = await extractErrorMessage(res, `加载失败 (HTTP ${res.status})`);
          if (!cancelled) {
            setLoadError(msg);
            setHtml(null);
          }
          return;
        }
        const text = await res.text();
        if (!cancelled) setHtml(text);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "加载失败");
          setHtml(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `updatedAt` changes on every write, so refetch on project mutation.
  }, [project.projectId, project.updatedAt, canEnter]);

  if (!canEnter) {
    return (
      <EmptyStateCard
        tab="html"
        requiredStage={requiredStageForTab("html")}
        currentStage={project.stage}
      />
    );
  }

  const compositionError = project.stageStatus.composition.error;
  const compositionStatus = project.stageStatus.composition.status;
  const compositionFailed =
    compositionStatus === "failed" && compositionError !== undefined;

  // Grid visibility: either the project has advanced to `composition`
  // (or later), or a composition run is currently in flight.
  const showSceneGrid =
    STAGE_ORDER[project.stage] >= STAGE_ORDER.composition ||
    compositionStatus === "running";

  const previewUrl = `/api/projects/${encodeURIComponent(project.projectId)}/composition/html`;

  return (
    <div className="flex flex-col gap-4">
      {compositionFailed && compositionError ? (
        <StageFailureBanner
          projectId={project.projectId}
          stage="composition"
          error={compositionError}
        />
      ) : null}

      {showSceneGrid ? (
        <SceneGrid
          projectId={project.projectId}
          storyboardScenes={project.storyboard?.scenes ?? []}
          compositionStatus={compositionStatus}
          projectUpdatedAt={project.updatedAt}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {loading
            ? "加载中…"
            : html !== null
              ? `${html.length.toLocaleString()} 字符`
              : "未加载"}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 items-center justify-center rounded-lg border border-input bg-background px-2.5 text-[0.8rem] font-medium transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            在浏览器预览
          </a>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={generating}
          >
            {generating ? "重新生成中…" : "重新生成 HTML"}
          </Button>
        </div>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {loadError}
        </div>
      ) : null}

      {actionError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </div>
      ) : null}

      {html !== null ? (
        <pre className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-muted/50 p-4 font-mono text-xs leading-relaxed">
          {html}
        </pre>
      ) : loading ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          加载中…
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="重新生成 HTML？"
        description={
          <>
            重新生成会覆盖当前的 HTML 场景。已生成的{" "}
            <span className="font-medium">音频</span>{" "}
            注入可能会被清理，需要重新运行音频生成。
          </>
        }
        confirmLabel="确认重新生成"
        destructive
        busy={generating}
        onConfirm={() => {
          void generate(true);
        }}
        onCancel={() => {
          if (!generating) setConfirmOpen(false);
        }}
      />
    </div>
  );
}
