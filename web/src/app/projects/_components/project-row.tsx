"use client";

/**
 * ProjectRow — single row in the `/projects` list.
 *
 * Renders a Next.js `<Link>` that navigates to `/projects/{projectId}`. The
 * delete button stops event propagation so the click never triggers the
 * enclosing link. Parent component is responsible for the confirm-dialog +
 * actual DELETE call; this component only surfaces the intent.
 *
 * _Requirements: 11.1, 11.8_
 */

import Link from "next/link";
import { Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/workbench/time-format";
import type { ProjectSummary, Stage } from "@/lib/workbench/types";

const TITLE_MAX_CHARS = 60;

// Per-stage color block used when no poster image is available.
// One distinct tone per stage — see Requirement 11.1.
const STAGE_COLOR: Record<Stage, string> = {
  topic: "bg-slate-200",
  brief: "bg-sky-200",
  storyboard: "bg-indigo-200",
  composition: "bg-violet-200",
  audio: "bg-fuchsia-200",
  render: "bg-orange-200",
  qa: "bg-amber-200",
  published: "bg-emerald-200",
};

const STAGE_LABEL: Record<Stage, string> = {
  topic: "选题",
  brief: "Brief",
  storyboard: "分镜",
  composition: "合成",
  audio: "配音",
  render: "渲染",
  qa: "QA",
  published: "已发布",
};

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  // Use a visible ellipsis so the cut is obvious to the user.
  return `${value.slice(0, max)}…`;
}

export interface ProjectRowProps {
  project: ProjectSummary;
  onDeleteClick: (project: ProjectSummary) => void;
  className?: string;
}

export function ProjectRow({
  project,
  onDeleteClick,
  className,
}: ProjectRowProps): React.JSX.Element {
  const { projectId, title, stage, updatedAt, posterUrl } = project;
  const displayTitle = truncate(title, TITLE_MAX_CHARS);
  const relativeTime = formatRelativeTime(new Date(), updatedAt);

  return (
    <Link
      href={`/projects/${projectId}`}
      className={cn(
        "group flex items-center gap-3 rounded-lg border border-border bg-background p-3 transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
      aria-label={`打开项目 ${displayTitle}`}
    >
      {/* Thumbnail / stage color block */}
      <div
        className={cn(
          "relative size-14 shrink-0 overflow-hidden rounded-md",
          !posterUrl && STAGE_COLOR[stage],
        )}
        aria-hidden="true"
      >
        {posterUrl ? (
          // Plain <img> — posters live under /public/videos which Next.js
          // serves statically. No optimization pipeline needed here.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={posterUrl}
            alt=""
            className="size-full object-cover"
            loading="lazy"
          />
        ) : null}
      </div>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-sm font-medium"
            title={title.length > TITLE_MAX_CHARS ? title : undefined}
          >
            {displayTitle}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-normal">
            {STAGE_LABEL[stage]}
          </Badge>
          <span>{relativeTime}</span>
        </div>
      </div>

      {/* Delete button */}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`删除项目 ${displayTitle}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDeleteClick(project);
        }}
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
      >
        <Trash2 />
      </Button>
    </Link>
  );
}
