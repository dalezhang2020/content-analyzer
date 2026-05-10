"use client";

/**
 * RenderTab — two modes:
 *   - Local (Kiro IDE): spawn hyperframes CLI subprocess, follow SSE
 *     progress stream, and display the resulting mp4.
 *   - Vercel: rendering is not available in the browser. Show the user
 *     the Kiro skill command to run locally, and if a video is already
 *     uploaded, play it.
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

  // Detect Vercel vs local Kiro at render time. We use hostname so the
  // decision is purely client-side — no env var leakage, no hydration
  // mismatch (the initial render on the server defaults to non-Vercel
  // and useEffect corrects it on mount).
  const [isVercel, setIsVercel] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsVercel(window.location.hostname.includes("vercel.app"));
    }
  }, []);

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
      // ignore
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
          /* ignore */
        }
      });

      es.addEventListener("line", (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data) as RenderEvent;
          if (parsed.type !== "line") return;
          setLatestLine(parsed.line);
        } catch {
          /* ignore */
        }
      });

      es.addEventListener("heartbeat", () => {
        setHeartbeats((n) => n + 1);
      });

      es.addEventListener("error", (ev) => {
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
            /* fall through */
          }
        }
        setConnectionLost(true);
      });
    },
    [closeStream, refreshProject],
  );

  // -----------------------------------------------------------------------
  // Effects
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!streamUrl) return;
    openStream(streamUrl);
    return () => {
      closeStream();
    };
  }, [streamUrl, openStream, closeStream]);

  // Local-only: fetch render log tail when no render is active.
  useEffect(() => {
    if (isVercel) return;
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
        /* ignore */
      } finally {
        if (!cancelled) setLogLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isVercel, project.projectId, project.updatedAt, canEnter, streamUrl]);

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

  // ---------------------------------------------------------------------
  // Vercel mode: show Kiro skill instructions + play existing video
  // ---------------------------------------------------------------------
  if (isVercel) {
    return (
      <div className="flex flex-col gap-4">
        {videoPath ? (
          <>
            <video
              key={videoPath}
              controls
              preload="metadata"
              src={videoPath}
              className="w-full rounded-lg border border-border bg-black aspect-video"
            />
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm">
              <div>
                <div className="font-medium text-foreground">当前视频来自本地渲染</div>
                <div className="text-xs text-muted-foreground mt-1">
                  想重新渲染，请在本地 Kiro IDE 中运行 skill
                </div>
              </div>
              <code className="text-xs bg-muted px-3 py-2 rounded-md font-mono">
                #workbench-render {project.projectId}
              </code>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-12 text-center">
            <p className="text-sm font-medium text-foreground">
              视频渲染需要在本地 Kiro IDE 中执行
            </p>
            <p className="text-xs text-muted-foreground max-w-md">
              HyperFrames 渲染用你的 Mac GPU（Metal + VideoToolbox），比云端快 3-5 倍。
              在 Kiro IDE 对话框中输入：
            </p>
            <code className="text-xs bg-muted px-3 py-2 rounded-md font-mono text-left w-full max-w-sm">
              #workbench-render {project.projectId}
            </code>
            <p className="text-xs text-muted-foreground">
              Kiro 会在本地从 Neon 拉取内容，运行 hyperframes render，
              然后自动上传 MP4 到 Vercel Blob。完成后刷新此页面即可播放。
            </p>
          </div>
        )}

        {renderFailed && renderError ? (
          <StageFailureBanner
            projectId={project.projectId}
            stage="render"
            error={renderError}
          />
        ) : null}
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // Local mode (Kiro IDE): full SSE-driven render with progress UI
  // ---------------------------------------------------------------------
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
          preload="metadata"
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
