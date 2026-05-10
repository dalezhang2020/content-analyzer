"use client";

/**
 * Shared tab utilities — empty-state card, confirmation modal, and a few
 * other building blocks reused across the 6 workbench tabs.
 *
 * These live as a standalone module so each tab file stays under the
 * design's ~250-line budget and so the visual treatment of the
 * "stage-not-ready" empty state is consistent across tabs.
 *
 * _Requirements: 12.2–12.11_
 */

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { Stage } from "@/lib/workbench/types";
import type { TabName } from "@/lib/workbench/constants";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// EmptyStateCard — rendered when a tab is gated behind a stage that hasn't
// been reached yet. Explains the required stage in Chinese and displays
// the user's current stage for context.
// ---------------------------------------------------------------------------

const TAB_LABEL: Record<TabName, string> = {
  brief: "Brief",
  storyboard: "Storyboard",
  html: "HTML",
  audio: "Audio",
  render: "Render",
  qa: "QA",
};

const STAGE_LABEL: Record<Stage, string> = {
  topic: "选题",
  brief: "Brief",
  storyboard: "Storyboard",
  composition: "HTML 场景",
  audio: "音频",
  render: "渲染",
  qa: "QA",
  published: "已发布",
};

export interface EmptyStateCardProps {
  tab: TabName;
  requiredStage: Stage;
  currentStage: Stage;
  className?: string;
}

export function EmptyStateCard({
  tab,
  requiredStage,
  currentStage,
  className,
}: EmptyStateCardProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-12 text-center",
        className,
      )}
    >
      <p className="text-sm font-medium text-foreground">
        需要先完成 &quot;{STAGE_LABEL[requiredStage]}&quot; 阶段
      </p>
      <p className="text-xs text-muted-foreground">
        当前阶段：{STAGE_LABEL[currentStage]}，完成后即可查看「{TAB_LABEL[tab]}
        」标签页的内容。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfirmDialog — minimal centered modal used for destructive / irreversible
// actions (regenerate brief, regenerate storyboard, regenerate HTML). Not
// wired to a shadcn primitive because this is the only place we need a
// plain "confirm" dialog in the workbench and adding a dependency purely
// for this would be overkill.
// ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element | null {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget && !busy) onCancel();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md space-y-4 rounded-lg border border-border bg-background p-6 shadow-lg"
      >
        <h3 className="text-base font-semibold">{title}</h3>
        <div className="text-sm text-muted-foreground">{description}</div>
        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "处理中…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// extractErrorMessage — pull `error.code / error.message` from a
// canonical ErrorResponse body; returns `fallback` on any parse miss.
// ---------------------------------------------------------------------------

export async function extractErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    if (body?.error?.message) {
      return body.error.code
        ? `${body.error.code}: ${body.error.message}`
        : body.error.message;
    }
  } catch {
    // fall through
  }
  return fallback;
}
