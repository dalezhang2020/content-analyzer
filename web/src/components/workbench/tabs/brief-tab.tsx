"use client";

/**
 * BriefTab — read-only display of the generated Brief with a single
 * destructive "重新生成 Brief" action.
 *
 * Stage gating: only available once the project has reached the `brief`
 * stage (or later); before that, renders an `EmptyStateCard`.
 *
 * Regeneration flow:
 *   1. User clicks "重新生成 Brief" → `ConfirmDialog` warns that
 *      downstream artefacts (storyboard / HTML / audio) may be
 *      invalidated.
 *   2. On confirm → `POST /api/projects/{id}/brief/generate` with
 *      `{ force: true }`.
 *   3. On success → parent is notified via `onProjectChanged(project)`.
 *   4. On failure → inline error message with the canonical error code.
 *
 * A `StageFailureBanner` surfaces any persisted `stageStatus.brief.error`
 * separately from the in-flight action error.
 */

import { useCallback, useState } from "react";

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

export interface BriefTabProps {
  project: Project;
  onProjectChanged: (project: Project) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BriefTab({
  project,
  onProjectChanged,
}: BriefTabProps): React.JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Shared generate/regenerate handler — `force: true` is only sent when
  // the brief already exists (i.e. we're regenerating, not first-time).
  const generate = useCallback(async (force = false) => {
    setGenerating(true);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.projectId)}/brief/generate`,
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
      onProjectChanged(updated);
      setConfirmOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  }, [project.projectId, onProjectChanged]);

  // -----------------------------------------------------------------------
  // New-project path — before the Brief is generated the project is at
  // `stage: "brief"` with a null `brief` field. Show a "generate" CTA
  // rather than the read-only viewer.
  // -----------------------------------------------------------------------
  if (!project.brief) {
    // On Vercel: Brief generation requires LLM (local Kiro). Show a
    // command to run in Kiro IDE rather than a button that would fail
    // with LOCAL_ONLY.
    const isVercel =
      typeof window !== "undefined" &&
      window.location.hostname.includes("vercel.app");

    if (isVercel) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-12 text-center">
          <p className="text-sm font-medium text-foreground">
            Brief 生成需要在本地 Kiro IDE 中执行
          </p>
          <p className="text-xs text-muted-foreground max-w-md">
            Brief 生成会消耗 LLM token（Claude），只能在本地 Kiro 里跑。
            在 Kiro IDE 对话框中输入：
          </p>
          <code className="text-xs bg-muted px-3 py-2 rounded-md font-mono text-left w-full max-w-md break-all">
            给 {project.projectId} 生成 Brief。选题：{project.topic}
          </code>
          <p className="text-xs text-muted-foreground">
            Kiro 会调用 LLM 生成 Brief 并推送到数据库，完成后刷新此页面即可看到结果。
          </p>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-12 text-center">
        <p className="text-sm font-medium text-foreground">
          点击下方按钮，AI 将根据你的选题生成内容卡（Brief）
        </p>
        <p className="text-xs text-muted-foreground">
          选题：{project.topic}
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
          {generating ? "生成中…" : "生成 Brief"}
        </Button>
      </div>
    );
  }

  if (!canEnterTab("brief", project.stage)) {
    return (
      <EmptyStateCard
        tab="brief"
        requiredStage={requiredStageForTab("brief")}
        currentStage={project.stage}
      />
    );
  }

  const brief = project.brief;
  const briefError = project.stageStatus.brief.error;
  const briefFailed =
    project.stageStatus.brief.status === "failed" && briefError !== undefined;

  const isVercel =
    typeof window !== "undefined" &&
    window.location.hostname.includes("vercel.app");

  return (
    <div className="flex flex-col gap-4">
      {briefFailed && briefError ? (
        <StageFailureBanner
          projectId={project.projectId}
          stage="brief"
          error={briefError}
        />
      ) : null}

      {brief ? (
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <h3 className="flex-1 text-lg font-semibold">{brief.title}</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={generating}
            >
              {generating ? "重新生成中…" : "重新生成 Brief"}
            </Button>
          </div>

          <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FieldBlock label="目标观众">
              <p className="text-sm leading-relaxed">{brief.audience}</p>
            </FieldBlock>
            <FieldBlock label="语气">
              <p className="text-sm leading-relaxed">{brief.tone}</p>
            </FieldBlock>
            <FieldBlock label="建议时长">
              <p className="text-sm leading-relaxed tabular-nums">
                {brief.targetDurationSec} 秒
              </p>
            </FieldBlock>
            <FieldBlock label="风格建议">
              <p className="text-sm leading-relaxed">{brief.suggestedStyle}</p>
            </FieldBlock>
            <FieldBlock label="核心观点" className="sm:col-span-2">
              <ul className="list-inside list-disc space-y-1 text-sm leading-relaxed">
                {brief.corePoints.map((point, idx) => (
                  <li key={idx}>{point}</li>
                ))}
              </ul>
            </FieldBlock>
          </dl>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Brief 数据尚未写入，请稍后刷新。
        </div>
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
        title={isVercel ? "在 Kiro IDE 中重新生成" : "重新生成 Brief？"}
        description={
          isVercel ? (
            <div className="flex flex-col gap-3">
              <p>
                重新生成需要 LLM，只能在本地 Kiro IDE 中跑。请在 Kiro
                对话框输入以下命令：
              </p>
              <code className="text-xs bg-muted px-3 py-2 rounded-md font-mono break-all">
                重新生成 {project.projectId} 的 Brief。选题：{project.topic}
              </code>
              <p className="text-xs text-muted-foreground">
                完成后刷新此页面即可看到新的 Brief。
              </p>
            </div>
          ) : (
            <>
              重新生成会基于当前主题重新调用 LLM。后续的{" "}
              <span className="font-medium">Storyboard、HTML、音频</span>{" "}
              可能需要重新生成以保持一致。
            </>
          )
        }
        confirmLabel={isVercel ? "知道了" : "确认重新生成"}
        destructive={!isVercel}
        busy={generating}
        onConfirm={() => {
          if (isVercel) {
            setConfirmOpen(false);
          } else {
            void generate(true);
          }
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

function FieldBlock({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={className}>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-foreground">{children}</dd>
    </div>
  );
}
