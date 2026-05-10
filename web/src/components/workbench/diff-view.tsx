"use client";

/**
 * DiffView — side-by-side before/after narration viewer used by
 * `SceneDrawer` to present the result of `POST /api/projects/{id}/
 * scenes/{sceneId}/rewrite`.
 *
 * Pure presentational — no data fetching, no state. The parent owns the
 * rewrite lifecycle and decides what "accept" / "discard" mean.
 */

import type React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface DiffViewProps {
  /** Narration text as it existed before the rewrite. */
  before: string;
  /** Narration text returned by the rewrite LLM. */
  after: string;
  /** Called when the user confirms they want to adopt the rewrite. */
  onAccept: () => void;
  /** Called when the user rejects the rewrite. */
  onDiscard: () => void;
  className?: string;
}

export function DiffView({
  before,
  after,
  onAccept,
  onDiscard,
  className,
}: DiffViewProps): React.JSX.Element {
  return (
    <div
      className={cn("flex flex-col gap-3", className)}
      role="group"
      aria-label="改写前后对比"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <DiffColumn label="改写前" tone="before" text={before} />
        <DiffColumn label="改写后" tone="after" text={after} />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDiscard}>
          放弃改写
        </Button>
        <Button type="button" variant="default" onClick={onAccept}>
          接受改写
        </Button>
      </div>
    </div>
  );
}

interface DiffColumnProps {
  label: string;
  tone: "before" | "after";
  text: string;
}

function DiffColumn({ label, tone, text }: DiffColumnProps): React.JSX.Element {
  const toneClass =
    tone === "before"
      ? "border-destructive/30 bg-destructive/5 text-foreground"
      : "border-emerald-600/30 bg-emerald-600/5 text-foreground dark:border-emerald-500/40 dark:bg-emerald-500/10";
  const labelClass =
    tone === "before"
      ? "text-destructive"
      : "text-emerald-700 dark:text-emerald-400";

  return (
    <div className="flex flex-col gap-1.5">
      <span className={cn("text-xs font-medium", labelClass)}>{label}</span>
      <div
        className={cn(
          "min-h-[6rem] rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap break-words",
          toneClass,
        )}
      >
        {text}
      </div>
    </div>
  );
}
