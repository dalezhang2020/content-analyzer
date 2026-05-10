"use client";

/**
 * SceneGrid — per-scene status grid shown on the HTML tab.
 *
 * Polls `GET /api/projects/{id}/composition/scenes` for the on-disk
 * state of each scene's sub-composition HTML file and renders a card
 * per storyboard scene. A "ready" card opens a preview drawer that
 * hosts the scene inside a sandboxed iframe (no `allow-same-origin`,
 * no `allow-forms`, no `allow-top-navigation`).
 *
 * Polling cadence:
 *   - One fetch on mount.
 *   - One fetch every time `projectUpdatedAt` changes (so regen flows
 *     and scene edits refresh without waiting for the interval).
 *   - `setInterval(2000)` while `compositionStatus === "running"`.
 *   - In-flight fetches are cancelled via `AbortController` on
 *     unmount and whenever a newer fetch starts.
 *
 * Failure policy:
 *   - Fetch failures are swallowed silently — the grid keeps showing
 *     the last-known state so a transient network hiccup doesn't flip
 *     every card back to "待生成".
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { Scene, StageStatusValue } from "@/lib/workbench/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Wire types — mirror the /composition/scenes response shape.
// ---------------------------------------------------------------------------

interface SceneStatus {
  sceneId: string;
  index: number;
  title: string;
  compositionId: string;
  relPath: string;
  exists: boolean;
  size: number;
  updatedAt?: string;
}

interface SceneStatusResponse {
  scenes: SceneStatus[];
}

type DerivedStatus = "ready" | "generating" | "failed" | "pending";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SceneGridProps {
  projectId: string;
  /** `project.storyboard?.scenes ?? []` — drives the grid's cells. */
  storyboardScenes: Scene[];
  /** Value of `project.stageStatus.composition.status`. */
  compositionStatus: StageStatusValue;
  /**
   * `project.updatedAt`. Treated as a cache-busting nonce: when it
   * changes, we refetch scene statuses immediately instead of waiting
   * for the next polling tick.
   */
  projectUpdatedAt: string;
}

const POLL_INTERVAL_MS = 2_000;
const TITLE_MAX = 40;

function truncateTitle(s: string): string {
  if (s.length <= TITLE_MAX) return s;
  return `${s.slice(0, TITLE_MAX - 1)}…`;
}

function deriveStatus(
  exists: boolean,
  compositionStatus: StageStatusValue,
): DerivedStatus {
  if (exists) return "ready";
  if (compositionStatus === "running") return "generating";
  if (compositionStatus === "failed") return "failed";
  return "pending";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SceneGrid({
  projectId,
  storyboardScenes,
  compositionStatus,
  projectUpdatedAt,
}: SceneGridProps): React.JSX.Element | null {
  const [statuses, setStatuses] = useState<Map<string, SceneStatus>>(
    () => new Map(),
  );
  const [preview, setPreview] = useState<SceneStatus | null>(null);
  // Single in-flight request per mount — abort + replace on every new fetch.
  const abortRef = useRef<AbortController | null>(null);

  const fetchStatuses = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/composition/scenes`,
        { method: "GET", signal: controller.signal },
      );
      if (!res.ok) return; // keep last-known state
      const body = (await res.json()) as SceneStatusResponse;
      if (controller.signal.aborted) return;

      const map = new Map<string, SceneStatus>();
      for (const s of body.scenes) map.set(s.sceneId, s);
      setStatuses(map);
    } catch {
      // Network / abort / parse errors — intentionally ignored. The UI
      // keeps rendering the previous snapshot so a flaky connection
      // doesn't blank the grid.
    }
  }, [projectId]);

  // Initial fetch + refetch on every project mutation.
  useEffect(() => {
    void fetchStatuses();
  }, [fetchStatuses, projectUpdatedAt]);

  // Poll at 2 s while composition is in flight.
  useEffect(() => {
    if (compositionStatus !== "running") return;
    const handle = setInterval(() => {
      void fetchStatuses();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [compositionStatus, fetchStatuses]);

  // Abort any in-flight fetch on unmount.
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  if (storyboardScenes.length === 0) return null;

  return (
    <>
      <section
        aria-label="Scene composition grid"
        data-testid="scene-grid"
        className="flex flex-col gap-2"
      >
        {storyboardScenes.map((scene) => {
          const status = statuses.get(scene.sceneId);
          const exists = Boolean(status?.exists);
          const derived = deriveStatus(exists, compositionStatus);
          return (
            <SceneCard
              key={scene.sceneId}
              index={scene.index}
              title={scene.title}
              derived={derived}
              size={status?.size}
              onPreview={
                derived === "ready" && status
                  ? () => setPreview(status)
                  : undefined
              }
            />
          );
        })}
      </section>

      <ScenePreviewDrawer
        projectId={projectId}
        scene={preview}
        onClose={() => setPreview(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// SceneCard — one cell of the grid.
// ---------------------------------------------------------------------------

interface SceneCardProps {
  index: number;
  title: string;
  derived: DerivedStatus;
  size: number | undefined;
  onPreview: (() => void) | undefined;
}

function SceneCard({
  index,
  title,
  derived,
  size,
  onPreview,
}: SceneCardProps): React.JSX.Element {
  const sizeLabel =
    size !== undefined && size > 0 ? `${Math.round(size / 1024)} KB` : "—";

  return (
    <div
      data-testid={`scene-card-${index}`}
      data-status={derived}
      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-sm font-medium text-foreground">
          #{index} · {truncateTitle(title)}
        </span>
        <StatusChip status={derived} />
      </div>
      <div className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {sizeLabel}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onPreview}
        disabled={!onPreview}
        aria-label={`Preview scene ${index}`}
        className="shrink-0"
      >
        点击预览
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusChip
// ---------------------------------------------------------------------------

const CHIP_BASE =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium";

function StatusChip({
  status,
}: {
  status: DerivedStatus;
}): React.JSX.Element {
  switch (status) {
    case "ready":
      return (
        <span
          className={cn(
            CHIP_BASE,
            "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          )}
        >
          已生成
        </span>
      );
    case "generating":
      return (
        <span
          className={cn(
            CHIP_BASE,
            "bg-blue-500/10 text-blue-600 dark:text-blue-400",
          )}
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-600 dark:bg-blue-400" />
          生成中
        </span>
      );
    case "failed":
      return (
        <span className={cn(CHIP_BASE, "bg-destructive/10 text-destructive")}>
          失败
        </span>
      );
    case "pending":
    default:
      return (
        <span className={cn(CHIP_BASE, "bg-muted text-muted-foreground")}>
          待生成
        </span>
      );
  }
}

// ---------------------------------------------------------------------------
// ScenePreviewDrawer — modal drawer hosting an iframe for a ready scene.
// ---------------------------------------------------------------------------

export interface ScenePreviewDrawerProps {
  projectId: string;
  scene: SceneStatus | null;
  onClose: () => void;
}

export function ScenePreviewDrawer({
  projectId,
  scene,
  onClose,
}: ScenePreviewDrawerProps): React.JSX.Element | null {
  // ESC closes the drawer for keyboard-only users.
  useEffect(() => {
    if (!scene) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [scene, onClose]);

  if (!scene) return null;

  const src = `/api/projects/${encodeURIComponent(projectId)}/composition/scenes/${encodeURIComponent(scene.compositionId)}`;
  const audioSrc = `/api/projects/${encodeURIComponent(projectId)}/audio/scenes/${scene.index}`;
  const frameTitle = `Scene ${scene.index} preview`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={frameTitle}
        className="flex w-full max-w-6xl flex-col gap-3 rounded-lg border border-border bg-background p-4 shadow-xl"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold">
              #{scene.index} · {scene.title}
            </h3>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {scene.compositionId}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close preview"
          >
            关闭
          </Button>
        </div>
        {/*
         * Sandbox rationale (defence-in-depth per Req 16.7):
         *   - `allow-scripts`           — HyperFrames scenes need JS
         *                                 for animation.
         *   - `allow-same-origin`       — OMITTED. iframe runs in an
         *                                 opaque origin, so even if the
         *                                 scene HTML is compromised it
         *                                 cannot read cookies, local-
         *                                 Storage, or the parent DOM.
         *   - `allow-forms`             — OMITTED so a compromised
         *                                 scene can't POST to arbitrary
         *                                 endpoints (data exfiltration).
         *   - `allow-top-navigation`    — OMITTED so scene HTML can't
         *                                 redirect the whole workbench.
         *   - `allow-popups`            — OMITTED; no new windows.
         *   - `allow-modals`            — OMITTED so rogue
         *                                 alert()/confirm() can't
         *                                 block the workbench.
         * LLM-authored HTML also passes through `scanHtml` server-side
         * for forbidden tokens (iframe, fetch(, etc.). This sandbox is
         * the second line of defence.
         */}
        <iframe
          data-testid="scene-preview-iframe"
          src={src}
          sandbox="allow-scripts"
          title={frameTitle}
          className="aspect-video w-full rounded-md border border-border bg-black"
        />
        {/*
         * TTS audio playback for alignment debugging. The scene audio
         * route (T54) streams the MP3 if it exists, otherwise returns
         * 404 — the browser shows a broken player in that case, which
         * is acceptable debug UX (no guard needed).
         */}
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            场景音频 — 与动画对齐播放可验证 TTS 是否匹配
          </p>
          <audio
            data-testid="scene-preview-audio"
            controls
            preload="metadata"
            src={audioSrc}
            className="w-full"
          />
        </div>
      </div>
    </div>
  );
}
