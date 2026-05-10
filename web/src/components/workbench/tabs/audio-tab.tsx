"use client";

/**
 * AudioTab — per-scene TTS status + batch & per-scene regenerate actions.
 *
 * Each row shows:
 *   - scene index / title
 *   - narration preview
 *   - voice badge
 *   - TTS status chip (未生成 / 已生成 / 失败 / 生成中)
 *   - "重新生成 TTS" per-scene button
 *
 * Top-bar actions:
 *   - "生成全部 Audio" → `POST .../audio/generate` (force omitted so
 *     existing mp3s are skipped). Surfaces partial failures from a 207
 *     response inline.
 *
 * Audio `<audio>` previews are deferred to a future iteration — the
 * per-project `data/` directory is outside Next.js's static handler so
 * serving an mp3 to the browser requires a dedicated route. For MVP we
 * surface only status + regenerate affordances.
 *
 * _Requirements: 12.6, 12.11_
 */

import { useCallback, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StageFailureBanner } from "@/components/workbench/stage-failure-banner";
import {
  EmptyStateCard,
  extractErrorMessage,
} from "@/components/workbench/tabs/_shared";
import { canEnterTab, requiredStageForTab } from "@/lib/workbench/tab-gating";
import type { Project, Scene, TTSBatchResult } from "@/lib/workbench/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AudioTabProps {
  project: Project;
  onProjectChanged: (project: Project) => void;
}

const NARRATION_PREVIEW_MAX = 60;

type SceneStatus = "missing" | "ready" | "failed" | "pending";

interface FailureDetail {
  index: number;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AudioTab({
  project,
  onProjectChanged,
}: AudioTabProps): React.JSX.Element {
  const [batchPending, setBatchPending] = useState(false);
  const [sceneRequestIds, setSceneRequestIds] = useState<Record<string, true>>(
    {},
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [failures, setFailures] = useState<FailureDetail[]>([]);

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------
  const runBatch = useCallback(async () => {
    setBatchPending(true);
    setActionError(null);
    setFailures([]);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.projectId)}/audio/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (res.status === 207) {
        const body = (await res.json()) as {
          project: Project;
          failures: TTSBatchResult["failures"];
        };
        onProjectChanged(body.project);
        setFailures(
          body.failures.map((f) => ({
            index: f.index,
            code: f.error.code,
            message: f.error.message,
          })),
        );
        return;
      }
      if (!res.ok) {
        const msg = await extractErrorMessage(res, "生成音频失败");
        setActionError(msg);
        return;
      }
      const updated = (await res.json()) as Project;
      onProjectChanged(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "生成音频失败");
    } finally {
      setBatchPending(false);
    }
  }, [project.projectId, onProjectChanged]);

  const runSceneTts = useCallback(
    async (scene: Scene) => {
      setSceneRequestIds((prev) => ({ ...prev, [scene.sceneId]: true }));
      setActionError(null);
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(project.projectId)}/scenes/${encodeURIComponent(scene.sceneId)}/tts`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        if (!res.ok) {
          const msg = await extractErrorMessage(res, "TTS 生成失败");
          setActionError(`Scene ${scene.index}: ${msg}`);
          return;
        }
        // The scene route returns the updated Scene; refresh the project
        // from the server so every caller sees consistent data (including
        // stageStatus, artifact paths, etc.).
        const projRes = await fetch(
          `/api/projects/${encodeURIComponent(project.projectId)}`,
          { method: "GET" },
        );
        if (projRes.ok) {
          const updated = (await projRes.json()) as Project;
          onProjectChanged(updated);
          // Clear any stale failure entry for this scene index.
          setFailures((prev) => prev.filter((f) => f.index !== scene.index));
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "TTS 生成失败");
      } finally {
        setSceneRequestIds((prev) => {
          const next = { ...prev };
          delete next[scene.sceneId];
          return next;
        });
      }
    },
    [project.projectId, onProjectChanged],
  );

  // -----------------------------------------------------------------------
  // Gating
  // -----------------------------------------------------------------------
  if (!canEnterTab("audio", project.stage)) {
    return (
      <EmptyStateCard
        tab="audio"
        requiredStage={requiredStageForTab("audio")}
        currentStage={project.stage}
      />
    );
  }

  const scenes = project.storyboard?.scenes ?? [];
  const audioError = project.stageStatus.audio.error;
  const audioFailed =
    project.stageStatus.audio.status === "failed" && audioError !== undefined;

  const failureByIndex = new Map<number, FailureDetail>();
  for (const f of failures) failureByIndex.set(f.index, f);

  function statusOf(scene: Scene): SceneStatus {
    if (sceneRequestIds[scene.sceneId]) return "pending";
    if (failureByIndex.has(scene.index)) return "failed";
    if (scene.audioPath && scene.audioPath.length > 0) return "ready";
    return "missing";
  }

  return (
    <div className="flex flex-col gap-4">
      {audioFailed && audioError ? (
        <StageFailureBanner
          projectId={project.projectId}
          stage="audio"
          error={audioError}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          共 {scenes.length} 个场景，
          <span className="font-medium text-foreground">
            {scenes.filter((s) => s.audioPath).length}
          </span>{" "}
          个已生成。
        </div>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => {
            void runBatch();
          }}
          disabled={batchPending || scenes.length === 0}
        >
          {batchPending ? "生成中…" : "生成全部 Audio"}
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

      {scenes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          暂无场景。请先生成 Storyboard。
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {scenes.map((scene) => {
            const status = statusOf(scene);
            const failure = failureByIndex.get(scene.index);
            const scenePending = Boolean(sceneRequestIds[scene.sceneId]);
            return (
              <li
                key={scene.sceneId}
                className="rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                    {scene.index}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {scene.title}
                      </span>
                      <Badge variant="outline" className="shrink-0">
                        {scene.voice}
                      </Badge>
                      <StatusChip status={status} />
                    </div>
                    <span className="truncate text-xs text-muted-foreground">
                      {truncateNarration(scene.narration)}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void runSceneTts(scene);
                    }}
                    disabled={scenePending || batchPending}
                  >
                    {scenePending ? "生成中…" : "重新生成 TTS"}
                  </Button>
                </div>
                {failure ? (
                  <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
                    <span className="font-mono font-medium">
                      {failure.code}
                    </span>{" "}
                    · {failure.message}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateNarration(text: string): string {
  if (text.length <= NARRATION_PREVIEW_MAX) return text;
  return text.slice(0, NARRATION_PREVIEW_MAX - 1) + "…";
}

function StatusChip({ status }: { status: SceneStatus }): React.JSX.Element {
  const styles: Record<SceneStatus, { label: string; className: string }> = {
    missing: {
      label: "未生成",
      className: "bg-muted text-muted-foreground",
    },
    ready: {
      label: "已生成",
      className:
        "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20",
    },
    failed: {
      label: "失败",
      className:
        "bg-destructive/10 text-destructive border border-destructive/20",
    },
    pending: {
      label: "生成中",
      className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20",
    },
  };
  const s = styles[status];
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}
