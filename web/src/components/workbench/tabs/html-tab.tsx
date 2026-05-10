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
 * Note: this tab is read-only w.r.t. the HTML content itself. Manual
 * HTML editing is a separate future-work affordance (surface area too
 * wide for MVP).
 *
 * _Requirements: 12.5, 12.11_
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { StageFailureBanner } from "@/components/workbench/stage-failure-banner";
import {
  ConfirmDialog,
  EmptyStateCard,
  extractErrorMessage,
} from "@/components/workbench/tabs/_shared";
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
  const [regenerating, setRegenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const canEnter = canEnterTab("html", project.stage);

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

  const regenerate = useCallback(async () => {
    setRegenerating(true);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.projectId)}/composition/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        },
      );
      if (!res.ok) {
        const msg = await extractErrorMessage(res, "重新生成失败");
        setActionError(msg);
        return;
      }
      const updated = (await res.json()) as Project;
      onProjectChanged?.(updated);
      setConfirmOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "重新生成失败");
    } finally {
      setRegenerating(false);
    }
  }, [project.projectId, onProjectChanged]);

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
  const compositionFailed =
    project.stageStatus.composition.status === "failed" &&
    compositionError !== undefined;

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
            disabled={regenerating}
          >
            {regenerating ? "重新生成中…" : "重新生成 HTML"}
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
        busy={regenerating}
        onConfirm={() => {
          void regenerate();
        }}
        onCancel={() => {
          if (!regenerating) setConfirmOpen(false);
        }}
      />
    </div>
  );
}
