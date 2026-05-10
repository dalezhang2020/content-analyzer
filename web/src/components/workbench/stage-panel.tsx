"use client";

/**
 * StagePanel — vertical list of the 8 workbench stages with per-stage status.
 *
 * Renders each stage in canonical `STAGES` order. The current stage is
 * visually highlighted with a ring; when `onStageClick` is provided each
 * row is rendered as a `<button>` so it is keyboard-accessible.
 *
 * Optional manual-regress integration: when both `projectId` and
 * `onProjectRegressed` are supplied, each row whose stage sits strictly
 * earlier than the current stage grows a small "回退到此阶段" button
 * (rendered via `StageRegressControl`). This gives users an explicit
 * escape hatch when the automatic pipeline's narrow regression edges
 * (`qa → {storyboard|composition|audio}`) aren't enough — e.g. going
 * from `published` back to `composition`. See
 * `state-machine.regressToStage` for the pure helper that backs this.
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
import { StageRegressControl } from "@/components/workbench/stage-regress-control";
import { STAGE_ORDER, STAGES } from "@/lib/workbench/constants";
import type { Project, Stage, StageStatusMap } from "@/lib/workbench/types";
import { cn } from "@/lib/utils";

export interface StagePanelProps {
  stages: StageStatusMap;
  currentStage: Stage;
  onStageClick?: (stage: Stage) => void;
  className?: string;
  /**
   * Project ID used to wire manual-regress fetches. When supplied
   * alongside `onProjectRegressed`, each earlier-stage row renders a
   * "回退到此阶段" control.
   */
  projectId?: string;
  /**
   * Callback invoked with the refreshed project after a successful
   * regression. Typically wired to the same state-update handler the
   * page uses for other project mutations.
   */
  onProjectRegressed?: (project: Project) => void;
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
  projectId,
  onProjectRegressed,
}: StagePanelProps): React.JSX.Element {
  const interactive = typeof onStageClick === "function";
  const regressEnabled =
    typeof projectId === "string" &&
    projectId.length > 0 &&
    typeof onProjectRegressed === "function";

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
        const isEarlier = STAGE_ORDER[stage] < STAGE_ORDER[currentStage];
        const showRegress = regressEnabled && isEarlier;

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

        // When the regress control is enabled we must render it OUTSIDE
        // the stage-click `<button>` — nested interactive elements are
        // invalid HTML. Wrap the whole row in a flex container so the
        // main row stays click-to-switch while the regress button sits
        // alongside it.
        if (showRegress) {
          const stageClickable = interactive ? (
            <button
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
          ) : (
            <div
              aria-current={isCurrent ? "step" : undefined}
              className={rowClass}
            >
              {rowInner}
            </div>
          );

          return (
            <div key={stage} className="flex items-center gap-2">
              <div className="flex-1 min-w-0">{stageClickable}</div>
              <StageRegressControl
                projectId={projectId!}
                targetStage={stage}
                targetLabel={meta.label}
                onRegressed={onProjectRegressed!}
              />
            </div>
          );
        }

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
