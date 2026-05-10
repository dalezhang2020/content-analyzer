"use client";

/**
 * LogViewer — modal popover that fetches and displays a tail of a
 * per-stage log file.
 *
 * Fetches `GET /api/projects/{projectId}/logs/{stage}?tail=500` when
 * `open` flips to `true`; the response is rendered as a dark-themed
 * monospace text block. The modal closes on explicit close-button
 * click, Escape key, or overlay click.
 *
 * Visual states:
 *   - loading — spinner + "加载中"
 *   - empty   — placeholder text when the log file does not exist yet
 *               (`exists: false`) or contains no non-empty lines
 *   - error   — red-tinted message block with retry button
 *   - ready   — fixed-height scrollable `<pre>` with the log lines
 */

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LogViewerProps {
  projectId: string;
  /** Stage name — one of the 8 canonical stages or `"system"`. */
  stage: string;
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Response shape — mirrors the `GET /logs/[stage]` route
// ---------------------------------------------------------------------------

interface LogResponse {
  lines: string[];
  exists: boolean;
  total?: number;
}

interface ApiError {
  error?: { code?: string; message?: string };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LogViewer({
  projectId,
  stage,
  open,
  onClose,
}: LogViewerProps): React.JSX.Element | null {
  const [lines, setLines] = useState<string[]>([]);
  const [exists, setExists] = useState<boolean>(true);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/logs/${encodeURIComponent(stage)}?tail=500`,
        { method: "GET" },
      );
      if (!res.ok) {
        // Try to surface the server error code/message; fall back to a
        // generic HTTP-status line if the envelope is unexpected.
        let msg = `HTTP ${res.status}`;
        try {
          const payload = (await res.json()) as ApiError;
          if (payload?.error?.code) {
            msg = `${payload.error.code}: ${payload.error.message ?? ""}`.trim();
          }
        } catch {
          // ignore parse failure, keep the HTTP-status fallback
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as LogResponse;
      setLines(Array.isArray(data.lines) ? data.lines : []);
      setExists(data.exists !== false);
      setTotal(typeof data.total === "number" ? data.total : 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, stage]);

  // Fetch once the popover opens (or the target stage changes while open).
  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    const handler = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${stage} 阶段日志`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(ev) => {
        // Only close when clicking the overlay itself, not child content.
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "flex w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl",
          "max-h-[85vh]",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-neutral-100">
              {stage} 阶段日志
            </h2>
            {exists && total > 0 ? (
              <span className="text-xs text-neutral-500">
                · 显示最后 {lines.length} / {total} 行
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
              className="text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
            >
              刷新
            </Button>
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto bg-neutral-950">
          {loading ? (
            <div className="flex h-full min-h-40 items-center justify-center text-sm text-neutral-500">
              加载中…
            </div>
          ) : error ? (
            <div className="m-4 rounded-md border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-200">
              <div className="mb-2 font-medium">加载失败</div>
              <div className="mb-3 break-all font-mono text-xs text-red-300">
                {error}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load()}
                className="border-red-800 bg-red-950/60 text-red-100 hover:bg-red-900/60"
              >
                重试
              </Button>
            </div>
          ) : !exists || lines.length === 0 ? (
            <div className="flex h-full min-h-40 items-center justify-center text-sm text-neutral-500">
              {exists ? "日志为空" : "暂无日志文件"}
            </div>
          ) : (
            <pre className="m-0 overflow-auto whitespace-pre-wrap break-all px-4 py-3 font-mono text-xs leading-relaxed text-neutral-200">
              {lines.join("\n")}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
