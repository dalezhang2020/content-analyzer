"use client";

/**
 * StagePanel — vertical list of the 5 workbench stages with per-stage
 * status. Renders each stage in canonical `STAGES` order; the current
 * stage gets an amber ring. When `onStageClick` is provided each row is
 * rendered as a `<button>` so it is keyboard-accessible.
 *
 * Simplified from the original 8-stage panel: manual regress control was
 * removed (the automatic pipeline is forward-only; rerun with force:true
 * is the supported re-do path).
 */

import {
  Code,
  FileText,
  List,
  Music,
  Play,
} from "lucide-react";

import { StageBadge } from "@/components/workbench/stage-badge";
import { STAGES } from "@/lib/workbench/constants";
import type { Project, Stage, StageStatusMap } from "@/lib/workbench/types";
import { cn } from "@/lib/utils";

export interface StagePanelProps {
  stages: StageStatusMap;
  currentStage: Stage;
  onStageClick?: (stage: Stage) => void;
  className?: string;
  /** Retained for API compatibility — no longer used after regress removal. */
  projectId?: string;
  onProjectRegressed?: (project: Project) => void;
}

interface StageMeta {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STAGE_META: Record<Stage, StageMeta> = {
  brief: { label: "内容卡", icon: FileText },
  storyboard: { label: "分镜", icon: List },
  composition: { label: "HTML 场景", icon: Code },
  audio: { label: "音频", icon: Music },
  render: { label: "渲染", icon: Play },
};

export function StagePanel({
  stages,
  currentStage,
  onStageClick,
  className,
}: StagePanelProps): React.JSX.Element {
  const interactive = typeof onStageClick === "function";

  return (
    <nav
      className={cn("flex flex-col gap-1", className)}
      aria-label="项目阶段"
    >
      {STAGES.map((stage) => {
        const meta = STAGE_META[stage];
        const Icon = meta.icon;
        const statusEntry = stages[stage];
        const isCurrent = stage === currentStage;

        const rowClass = cn(
          "flex w-full items-center gap-3 rounded-md border border-transparent px-3 py-2 text-left transition-colors",
          "text-sm",
          isCurrent
            ? "border-amber-600/40 bg-amber-600/5 ring-1 ring-amber-600/30"
            : "hover:bg-muted/60",
        );

        const rowInner = (
          <>
            <Icon
              className={cn(
                "size-4 shrink-0",
                isCurrent ? "text-amber-600" : "text-muted-foreground",
              )}
            />
            <span
              className={cn(
                "flex-1 truncate font-medium",
                isCurrent ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {meta.label}
            </span>
            <StageBadge status={statusEntry.status} />
          </>
        );

        if (interactive) {
          return (
            <button
              key={stage}
              type="button"
              onClick={() => onStageClick?.(stage)}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                rowClass,
                "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              {rowInner}
            </button>
          );
        }

        return (
          <div
            key={stage}
            aria-current={isCurrent ? "step" : undefined}
            className={rowClass}
          >
            {rowInner}
          </div>
        );
      })}
    </nav>
  );
}
