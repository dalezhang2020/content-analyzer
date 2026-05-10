"use client";

/**
 * StageRegressControl — per-stage-row "回退到此阶段" button.
 *
 * Rendered alongside each `StagePanel` row whose stage is strictly
 * earlier than the project's current stage. Clicking opens a
 * `ConfirmDialog` explaining the consequences, then POSTs to the
 * manual-regression endpoint (`/api/projects/{id}/regress`) and pipes
 * the refreshed project through `onRegressed`.
 *
 * Separation of concerns:
 *   - `StagePanel` stays pure and stateless (pure render of the 8 stage
 *     rows with click-to-switch-tab behaviour).
 *   - This component owns the confirm dialog, the fetch, error display,
 *     and the busy state — kept small so it composes cleanly inside a
 *     stage row without bloating the panel.
 *
 * _Requirements: 1.4, 1.5_
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  ConfirmDialog,
  extractErrorMessage,
} from "@/components/workbench/tabs/_shared";
import type { Project, Stage } from "@/lib/workbench/types";

export interface StageRegressControlProps {
  projectId: string;
  targetStage: Stage;
  targetLabel: string;
  onRegressed: (project: Project) => void;
}

export function StageRegressControl({
  projectId,
  targetStage,
  targetLabel,
  onRegressed,
}: StageRegressControlProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runRegress = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/regress`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: targetStage }),
        },
      );
      if (!res.ok) {
        const message = await extractErrorMessage(
          res,
          `回退失败 (${res.status})`,
        );
        setError(message);
        return;
      }
      const project = (await res.json()) as Project;
      onRegressed(project);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络错误，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={(ev) => {
          // Don't trigger the enclosing "switch to this stage" click.
          ev.stopPropagation();
          setError(null);
          setOpen(true);
        }}
        aria-label={`回退到 ${targetLabel} 阶段`}
      >
        回退到此阶段
      </Button>

      <ConfirmDialog
        open={open}
        title={`回退到 ${targetLabel}？`}
        description={
          <div className="space-y-2">
            <p>
              回退到{" "}
              <span className="font-medium">{targetLabel}</span>{" "}
              会把{" "}
              <span className="font-medium">{targetLabel}</span>{" "}
              及之后所有阶段的状态重置为 pending，已生成的内容文件保留但状态会失效，需要重新运行对应阶段。确认继续？
            </p>
            {error ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive"
              >
                {error}
              </p>
            ) : null}
          </div>
        }
        confirmLabel="确认回退"
        destructive
        busy={busy}
        onConfirm={() => {
          void runRegress();
        }}
        onCancel={() => {
          if (!busy) {
            setOpen(false);
            setError(null);
          }
        }}
      />
    </>
  );
}
