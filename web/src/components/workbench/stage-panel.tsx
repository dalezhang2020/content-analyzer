"use client";

/**
 * StagePanel — vertical list of the 8 workbench stages with per-stage status.
 *
 * Renders each stage in canonical `STAGES` order. The current stage is
 * visually highlighted with a ring; when `onStageClick` is provided each
 * row is rendered as a `<button>` so it is keyboard-accessible.
 */

import {
  CheckCircle,
  Clapperboard,
  Code,
  FileText,
  Lightbulb,
  List,
  MessageSquare,
  Music,
  Play,
} from "lucide-react";

import { StageBadge } from "@/components/workbench/stage-badge";
import { STAGES } from "@/lib/workbench/constants";
import type { Stage, StageStatusMap } from "@/lib/workbench/types";
import { cn } from "@/lib/utils";

export interface StagePanelProps {
  stages: StageStatusMap;
  currentStage: Stage;
  onStageClick?: (stage: Stage) => void;
  className?: string;
}

interface StageMeta {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STAGE_META: Record<Stage, StageMeta> = {
  topic: { label: "选题", icon: Lightbulb },
  brief: { label: "内容卡", icon: FileText },
  storyboard: { label: "分镜", icon: List },
  composition: { label: "HTML 场景", icon: Code },
  audio: { label: "音频", icon: Music },
  render: { label: "渲染", icon: Play },
  qa: { label: "QA", icon: MessageSquare },
  published: { label: "已发布", icon: CheckCircle },
};

// Fallback icon if the meta map is ever missing a stage (shouldn't happen —
// `STAGE_META` is a `Record<Stage, _>` so TS enforces exhaustiveness).
const FALLBACK_ICON = Clapperboard;

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
        const meta = STAGE_META[stage] ?? { label: stage, icon: FALLBACK_ICON };
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

        const content = (
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
              {content}
            </button>
          );
        }

        return (
          <div
            key={stage}
            aria-current={isCurrent ? "step" : undefined}
            className={rowClass}
          >
            {content}
          </div>
        );
      })}
    </nav>
  );
}
