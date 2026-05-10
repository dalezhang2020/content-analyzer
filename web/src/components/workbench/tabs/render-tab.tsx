"use client";

/**
 * RenderTab — spawn a HyperFrames render, follow its SSE progress
 * stream, and display the resulting mp4.
 *
 * Flow:
 *   1. Mount: if a video already exists, display it. Fetch log tail
 *      `GET /api/projects/{id}/logs/render?tail=200` in the background
 *      to populate the log preview.
 *   2. User clicks "开始渲染" → `POST /api/projects/{id}/render` →
 *      receives `{ runId, streamUrl }` → open `new EventSource(streamUrl)`.
 *   3. Progress updates come via named events:
 *        - `stage`: update the current stage label (starting / rendering
 *          / encoding / done / failed). Terminal events (done / failed)
 *          close the EventSource and re-fetch the project.
 *        - `line`: update the most-recent log line (1-line preview).
 *        - `heartbeat`: bump a heartbeat counter to pulse a liveness dot.
 *        - `error`: close the stream and surface the error message.
 *   4. If `EventSource.onerror` fires on an unclosed stream, show a
 *      "连接已断开，点击重试" banner with a manual reconnect button
 *      that reopens the same stream URL.
 *
 * Keep SSE handling local to the tab so there's no global EventSource
 * leak — `useEffect` cleanup closes the stream on unmount.
 *
 * _Requirements: 10.7, 12.7, 12.9_
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { StageFailureBanner } from "@/components/workbench/stage-failure-banner";
import {
  EmptyStateCard,
  extractErrorMessage,
} from "@/components/workbench/tabs/_shared";
import { canEnterTab, requiredStageForTab } from "@/lib/workbench/tab-gating";
import type { Project, RenderEvent } from "@/lib/workbench/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RenderTabProps {
  project: Project;
  onProjectChanged: (project: Project) => void;
}

type RenderStage =
  | "idle"
  | "starting"
  | "rendering"
  | "encoding"
  | "done"
  | "failed";

const STAGE_LABEL: Record<RenderStage, string> = {
  idle: "空闲",
  starting: "启动中",
  rendering: "渲染中",
  encoding: "编码中",
  done: "已完成",
  failed: "失败",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RenderTab({
  project,
  onProjectChanged,
}: RenderTabProps): React.JSX.Element {
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [renderStage, setRenderStage] = useState<RenderStage>("idle");
  const [latestLine, setLatestLine] = useState<string | null>(null);
  const [heartbeats, setHeartbeats] = useState(0);
  const [connectionLost, setConnectionLost] = useState(false);
  const [terminalMessage, setTerminalMessage] = useState<string | null>(null);

  const [logTail, setLogTail] = useState<string[]>([]);
  const [logLoading, setLogLoading] = useState(false);

  const esRef = useRef<EventSource | null>(null);

  const canEnter = canEnterTab("render", project.stage);

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
  const refreshProject = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.projectId)}`,
        { method: "GET" },
      );
      if (res.ok) {
        const updated = (await res.json()) as Project;
        onProjectChanged(updated);
      }
    } catch {
      // ignore — the poll loop on the page will refresh anyway
    }
  }, [project.projectId, onProjectChanged]);

  const closeStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const openStream = useCallback(
    (url: string) => {
      closeStream();
      setConnectionLost(false);
      const es = new EventSource(url);
      esRef.current = es;

      es.addEventListener("stage", (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data) as RenderEvent;
          if (parsed.type !== "stage") return;
          setRenderStage(parsed.stage as RenderStage);
          if (parsed.stage === "done" || parsed.stage === "failed") {
            if (parsed.stage === "failed") {
              setTerminalMessage("渲染失败，请查看日志。");
            }
            closeStream();
            setStreamUrl(null);
            void refreshProject();
          }
        } catch {
          // ignore malformed frame
        }
      });

      es.addEventListener("line", (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data) as RenderEvent;
          if (parsed.type !== "line") return;
          setLatestLine(parsed.line);
        } catch {
          // ignore
        }
      });

      es.addEventListener("heartbeat", () => {
        setHeartbeats((n) => n + 1);
      });

      es.addEventListener("error", (ev) => {
        // Two cases here:
        //   1. A named `error` SSE frame from the server (payload includes
        //      type: "error"). Parse it and show the message.
        //   2. A transport-layer onerror (no data). Treat as a dropped
        //      connection and surface the reconnect banner.
        const messageEv = ev as MessageEvent<string | undefined>;
        const data = typeof messageEv.data === "string" ? messageEv.data : "";
        if (data.length > 0) {
          try {
            const parsed = JSON.parse(data) as RenderEvent;
            if (parsed.type === "error") {
              setTerminalMessage(`${parsed.code}: ${parsed.message}`);
              setRenderStage("failed");
              closeStream();
              setStreamUrl(null);
              void refreshProject();
              return;
            }
          } catch {
            // fall through
          }
        }
        // Transport drop — keep `streamUrl` so the user can retry.
        setConnectionLost(true);
      });
    },
    [closeStream, refreshProject],
  );

  // -----------------------------------------------------------------------
  // Effects
  // -----------------------------------------------------------------------

  // Open EventSource whenever `streamUrl` is set. Reconnect is performed
  // by re-assigning the same `streamUrl` via `handleReconnect`.
  useEffect(() => {
    if (!streamUrl) return;
    openStream(streamUrl);
    return () => {
      closeStream();
    };
  }, [streamUrl, openStream, closeStream]);

  // Fetch render log tail on mount when no render is active.
  useEffect(() => {
    if (!canEnter) return;
    if (streamUrl) return;

    let cancelled = false;
    setLogLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(project.projectId)}/logs/render?tail=200`,
          { method: "GET" },
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          lines: string[];
          exists: boolean;
        };
        if (!cancelled) {
          setLogTail(Array.isArray(body.lines) ? body.lines : []);
        }
      } catch {
        // ignore — log preview is best-effort
      } finally {
        if (!cancelled) setLogLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [project.projectId, project.updatedAt, canEnter, streamUrl]);

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------
  const startRender = useCallback(async () => {
    setStarting(true);
    setActionError(null);
    setTerminalMessage(null);
    setLatestLine(null);
    setHeartbeats(0);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.projectId)}/render`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) {
        const msg = await extractErrorMessage(res, "启动渲染失败");
        setActionError(msg);
        return;
      }
      const body = (await res.json()) as { runId: string; streamUrl: string };
      setRenderStage("starting");
      setStreamUrl(body.streamUrl);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "启动渲染失败");
    } finally {
      setStarting(false);
    }
  }, [project.projectId]);

  const handleReconnect = useCallback(() => {
    if (!streamUrl) return;
    // Force useEffect to re-run by briefly clearing then restoring the
    // URL. `openStream` will close the old handle and open a fresh one.
    const url = streamUrl;
    setStreamUrl(null);
    setTimeout(() => setStreamUrl(url), 0);
  }, [streamUrl]);

  // -----------------------------------------------------------------------
  // Gating
  // -----------------------------------------------------------------------
  if (!canEnter) {
    return (
      <EmptyStateCard
        tab="render"
        requiredStage={requiredStageForTab("render")}
        currentStage={project.stage}
      />
    );
  }

  const renderError = project.stageStatus.render.error;
  const renderFailed =
    project.stageStatus.render.status === "failed" && renderError !== undefined;

  const videoPath = project.artifacts.videoPath;
  const streaming = streamUrl !== null;
  const renderStatus = project.stageStatus.render.status;

  // "启动" is disabled while a render is in flight OR while the render
  // stage is already running server-side (e.g. page reloaded mid-render).
  const startDisabled =
    starting || streaming || renderStatus === "running";

  return (
    <div className="flex flex-col gap-4">
      {renderFailed && renderError ? (
        <StageFailureBanner
          projectId={project.projectId}
          stage="render"
          error={renderError}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-sm">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
              stageChipStyle(renderStage),
            )}
          >
            {streaming && renderStage !== "failed" && renderStage !== "done" ? (
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-current" />
              </span>
            ) : null}
            {STAGE_LABEL[renderStage]}
          </span>
          {streaming ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              心跳 · {heartbeats}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => {
            void startRender();
          }}
          disabled={startDisabled}
        >
          {starting
            ? "启动中…"
            : streaming
              ? "渲染进行中"
              : videoPath
                ? "重新渲染"
                : "开始渲染"}
        </Button>
      </div>

      {actionError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </div>
      ) : null}

      {connectionLost ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
        >
          <span>连接已断开，点击重试</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleReconnect}
          >
            重连
          </Button>
        </div>
      ) : null}

      {terminalMessage ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {terminalMessage}
        </div>
      ) : null}

      {streaming && latestLine ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
          <span className="text-foreground/60">最新日志：</span>
          <span className="ml-1 break-all">{latestLine}</span>
        </div>
      ) : null}

      {videoPath ? (
        <video
          key={videoPath}
          controls
          src={videoPath}
          className="w-full rounded-lg border border-border bg-black aspect-video"
        />
      ) : !streaming ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          尚未渲染出视频。点击「开始渲染」。
        </div>
      ) : null}

      {!streaming ? (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-muted-foreground">
            渲染日志 (最近 200 行)
          </div>
          {logLoading ? (
            <div className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
              加载中…
            </div>
          ) : logTail.length === 0 ? (
            <div className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
              暂无日志
            </div>
          ) : (
            <pre className="max-h-80 overflow-auto rounded-md border border-border bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-200">
              {logTail.join("\n")}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stageChipStyle(stage: RenderStage): string {
  switch (stage) {
    case "idle":
      return "border-border bg-muted text-muted-foreground";
    case "starting":
    case "rendering":
    case "encoding":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400";
    case "done":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive";
  }
}
