"use client";

/**
 * StageFailureBanner — red-tinted banner shown when a workbench stage
 * has failed. Surfaces the canonical error `code` and the first 200
 * characters of the `message`, plus a "查看完整日志" button that opens
 * the `LogViewer` popover for the same stage.
 *
 * Usage:
 *   <StageFailureBanner
 *     projectId={project.projectId}
 *     stage="render"
 *     error={project.stageStatus.render.error!}
 *   />
 *
 * Internal state controls the popover visibility — parents don't have
 * to wire up any viewer plumbing.
 *
 * _Requirements: 14.4, 14.5_
 */

import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { LogViewer } from "@/components/workbench/log-viewer";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StageFailureBannerProps {
  error: { code: string; message: string };
  projectId: string;
  /** Stage name — one of the 8 canonical stages or `"system"`. */
  stage: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Message truncation
// ---------------------------------------------------------------------------

/** Banner-level cap on the inline error message. Full text lives in the log. */
const BANNER_MESSAGE_MAX = 200;

function truncateForBanner(message: string): string {
  if (message.length <= BANNER_MESSAGE_MAX) return message;
  return message.slice(0, BANNER_MESSAGE_MAX - 1) + "…";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StageFailureBanner({
  error,
  projectId,
  stage,
  className,
}: StageFailureBannerProps): React.JSX.Element {
  const [viewerOpen, setViewerOpen] = useState(false);

  return (
    <>
      <div
        role="alert"
        className={cn(
          "flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-red-900",
          "dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100",
          className,
        )}
      >
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-red-500 dark:text-red-400"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs font-bold uppercase tracking-wide text-red-700 dark:text-red-300">
              {error.code}
            </span>
          </div>
          <p className="mt-1 break-words text-sm leading-relaxed">
            {truncateForBanner(error.message)}
          </p>
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            className={cn(
              "mt-2 inline-flex items-center text-sm font-medium text-red-700 underline underline-offset-2 transition-colors hover:text-red-900",
              "dark:text-red-300 dark:hover:text-red-100",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-red-50 dark:focus-visible:ring-offset-red-950",
            )}
          >
            查看完整日志
          </button>
        </div>
      </div>

      <LogViewer
        projectId={projectId}
        stage={stage}
        open={viewerOpen}
        onClose={() => setViewerOpen(false)}
      />
    </>
  );
}
