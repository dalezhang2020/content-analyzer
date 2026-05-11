"use client";

/**
 * StoryboardTab — list of scenes with per-row edit affordance.
 *
 * Each row surfaces:
 *   - 1-based `index` badge
 *   - scene `title`
 *   - narration preview (first 60 chars)
 *   - `durationSec` with unit
 *   - `voice` badge
 *
 * Clicking a row delegates to `onSceneOpen(scene)` so the parent can
 * mount the `SceneDrawer` (this tab stays stateless aside from the
 * regenerate flow).
 *
 * Regeneration: "重新生成 Storyboard" button → confirmation dialog →
 * `POST .../storyboard/generate` with `{ force: true }`. Downstream
 * artefacts (HTML, audio) will become stale, which the confirmation
 * copy highlights.
 */

import { useCallback, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StageFailureBanner } from "@/components/workbench/stage-failure-banner";
import {
  ConfirmDialog,
  EmptyStateCard,
  extractErrorMessage,
} from "@/components/workbench/tabs/_shared";
import { canEnterTab, requiredStageForTab } from "@/lib/workbench/tab-gating";
import type { Project, Scene } from "@/lib/workbench/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StoryboardTabProps {
  project: Project;
  onProjectChanged: (project: Project) => void;
  onSceneOpen: (scene: Scene) => void;
}

const NARRATION_PREVIEW_MAX = 60;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StoryboardTab({
  project,
  onProjectChanged,
  onSceneOpen,
}: StoryboardTabProps): React.JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const generate = useCallback(async (force = false) => {
    setGenerating(true);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.projectId)}/storyboard/generate`,
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
      const body = (await res.json()) as {
        project: Project;
        warning?: string;
      };
      onProjectChanged(body.project);
      setConfirmOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  }, [project.projectId, onProjectChanged]);

  // stage=brief: show "generate storyboard" CTA (first-time generation is
  // what advances the project brief → storyboard).
  if (project.stage === "brief") {
    // On Vercel: Storyboard generation requires LLM (local Kiro).
    const isVercel =
      typeof window !== "undefined" &&
      window.location.hostname.includes("vercel.app");

    if (isVercel) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-12 text-center">
          <p className="text-sm font-medium text-foreground">
            Storyboard 生成需要在本地 Kiro IDE 中执行
          </p>
          <p className="text-xs text-muted-foreground max-w-md">
            分镜生成会消耗 LLM token，只能在本地 Kiro 里跑。
            在 Kiro IDE 对话框中输入：
          </p>
          <code className="text-xs bg-muted px-3 py-2 rounded-md font-mono text-left w-full max-w-md break-all">
            给 {project.projectId} 生成 Storyboard
          </code>
          <p className="text-xs text-muted-foreground">
            当前 Brief：{project.brief?.title ?? "（未生成）"}
          </p>
          <p className="text-xs text-muted-foreground">
            Kiro 会基于 Brief 分镜，完成后刷新页面即可看到结果。
          </p>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-12 text-center">
        <p className="text-sm font-medium text-foreground">
          点击下方按钮，AI 将根据 Brief 生成分镜（Storyboard）
        </p>
        <p className="text-xs text-muted-foreground">
          当前 Brief：{project.brief?.title ?? "（未生成）"}
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
          {generating ? "生成中…" : "生成 Storyboard"}
        </Button>
      </div>
    );
  }

  // Gating check for earlier stages (topic)
  if (!canEnterTab("storyboard", project.stage)) {
    return (
      <EmptyStateCard
        tab="storyboard"
        requiredStage={requiredStageForTab("storyboard")}
        currentStage={project.stage}
      />
    );
  }

  const scenes = project.storyboard?.scenes ?? [];
  const storyboardError = project.stageStatus.storyboard.error;
  const storyboardFailed =
    project.stageStatus.storyboard.status === "failed" &&
    storyboardError !== undefined;

  return (
    <div className="flex flex-col gap-4">
      {storyboardFailed && storyboardError ? (
        <StageFailureBanner
          projectId={project.projectId}
          stage="storyboard"
          error={storyboardError}
        />
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          共 <span className="font-medium text-foreground">{scenes.length}</span>{" "}
          个场景
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={generating}
        >
          {generating ? "重新生成中…" : "重新生成 Storyboard"}
        </Button>
      </div>

      {scenes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          暂无场景。点击「重新生成 Storyboard」以生成分镜。
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {scenes.map((scene) => (
            <li key={scene.sceneId}>
              <button
                type="button"
                onClick={() => onSceneOpen(scene)}
                className="group flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:border-ring hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
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
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {truncateNarration(scene.narration)}
                  </span>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {scene.durationSec}s
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {actionError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="重新生成 Storyboard？"
        description={
          <>
            重新生成会覆盖当前的所有场景。已生成的{" "}
            <span className="font-medium">HTML 与音频</span>{" "}
            可能需要重新生成以保持一致。
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateNarration(text: string): string {
  if (text.length <= NARRATION_PREVIEW_MAX) return text;
  return text.slice(0, NARRATION_PREVIEW_MAX - 1) + "…";
}
