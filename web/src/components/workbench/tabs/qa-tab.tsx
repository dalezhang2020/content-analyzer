"use client";

/**
 * QaTab — chronological list of `QaNote` entries plus an "add note" form.
 *
 * Stage gating: requires the project to have reached `render` (the QA
 * feedback loop is only useful once there's a video to critique).
 *
 * Each note row shows:
 *   - relative time (via `formatRelativeTime`, re-computed every render
 *     against `Date.now()`)
 *   - author
 *   - optional scene badge (`"Scene N — Title"` when the id resolves to
 *     a known scene, or the raw id as a fallback)
 *   - note text (preserving line breaks via `whitespace-pre-wrap`)
 *
 * Add form:
 *   - textarea (1–2000 chars, matches `LIMITS.QA_NOTE_MAX`).
 *   - scene `<select>` populated from `project.storyboard.scenes`
 *     with a "项目整体" entry at the top that maps to `sceneId: null`.
 *   - Submit posts to `POST /api/projects/{id}/qa-notes`; on success the
 *     project is re-fetched so downstream components (e.g. scene drawer)
 *     observe the new note.
 *
 * _Requirements: 12.10, 12.11_
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EmptyStateCard,
  extractErrorMessage,
} from "@/components/workbench/tabs/_shared";
import { LIMITS } from "@/lib/workbench/constants";
import { canEnterTab, requiredStageForTab } from "@/lib/workbench/tab-gating";
import { formatRelativeTime } from "@/lib/workbench/time-format";
import type { Project, QaNote } from "@/lib/workbench/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface QaTabProps {
  project: Project;
  onProjectChanged: (project: Project) => void;
}

const PROJECT_LEVEL_VALUE = "__project__";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QaTab({
  project,
  onProjectChanged,
}: QaTabProps): React.JSX.Element {
  const [text, setText] = useState("");
  const [sceneSelect, setSceneSelect] = useState(PROJECT_LEVEL_VALUE);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Refresh relative timestamps once per minute while the tab is visible.
  const [nowTick, setNowTick] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const scenes = useMemo(
    () => project.storyboard?.scenes ?? [],
    [project.storyboard],
  );

  const sceneLookup = useMemo(() => {
    const m = new Map<string, { index: number; title: string }>();
    for (const s of scenes) m.set(s.sceneId, { index: s.index, title: s.title });
    return m;
  }, [scenes]);

  // Newest notes first for readability; the server persists in insertion
  // order so a reverse() on the display side is sufficient.
  const sortedNotes = useMemo<QaNote[]>(() => {
    return [...project.qaNotes].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }, [project.qaNotes]);

  const trimmedText = text.trim();
  const formValid =
    trimmedText.length >= 1 && trimmedText.length <= LIMITS.QA_NOTE_MAX;

  // -----------------------------------------------------------------------
  // Submit
  // -----------------------------------------------------------------------
  const submit = useCallback(async () => {
    if (!formValid || submitting) return;
    setSubmitting(true);
    setSubmitError(null);

    const sceneId =
      sceneSelect === PROJECT_LEVEL_VALUE ? null : sceneSelect;

    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.projectId)}/qa-notes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sceneId, text: trimmedText }),
        },
      );
      if (!res.ok) {
        const msg = await extractErrorMessage(res, "保存 QA 笔记失败");
        setSubmitError(msg);
        return;
      }
      // Refresh full project so all consumers see the new note (the POST
      // endpoint returns only the note itself).
      const projRes = await fetch(
        `/api/projects/${encodeURIComponent(project.projectId)}`,
        { method: "GET" },
      );
      if (projRes.ok) {
        const updated = (await projRes.json()) as Project;
        onProjectChanged(updated);
      }
      setText("");
      setSceneSelect(PROJECT_LEVEL_VALUE);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "保存 QA 笔记失败");
    } finally {
      setSubmitting(false);
    }
  }, [
    formValid,
    submitting,
    sceneSelect,
    project.projectId,
    trimmedText,
    onProjectChanged,
  ]);

  // -----------------------------------------------------------------------
  // Gating
  // -----------------------------------------------------------------------
  if (!canEnterTab("qa", project.stage)) {
    return (
      <EmptyStateCard
        tab="qa"
        requiredStage={requiredStageForTab("qa")}
        currentStage={project.stage}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Add form */}
      <form
        className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-foreground">
            关联场景
          </label>
          <select
            value={sceneSelect}
            onChange={(e) => setSceneSelect(e.target.value)}
            disabled={submitting}
            className={cn(
              "h-8 w-full max-w-md rounded-lg border border-input bg-transparent px-2 text-sm outline-none transition-colors",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              "dark:bg-input/30",
            )}
          >
            <option value={PROJECT_LEVEL_VALUE}>项目整体</option>
            {scenes.map((s) => (
              <option key={s.sceneId} value={s.sceneId}>
                Scene {s.index} — {s.title}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-foreground">
              反馈内容
            </label>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {text.length} / {LIMITS.QA_NOTE_MAX}
            </span>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            maxLength={LIMITS.QA_NOTE_MAX}
            disabled={submitting}
            placeholder="写下你对这个场景或整体的反馈…"
            className={cn(
              "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              "dark:bg-input/30",
              "disabled:opacity-60",
            )}
          />
        </div>

        {submitError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {submitError}
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            disabled={!formValid || submitting}
          >
            {submitting ? "保存中…" : "保存 QA 笔记"}
          </Button>
        </div>
      </form>

      {/* Notes list */}
      {sortedNotes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          暂无 QA 笔记。
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {sortedNotes.map((note) => {
            const sceneInfo = note.sceneId
              ? sceneLookup.get(note.sceneId)
              : null;
            return (
              <li
                key={note.noteId}
                className="rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    {formatRelativeTime(nowTick, note.createdAt)}
                  </span>
                  <span>·</span>
                  <span>{note.author}</span>
                  {note.sceneId ? (
                    <Badge variant="outline" className="shrink-0">
                      {sceneInfo
                        ? `Scene ${sceneInfo.index} — ${sceneInfo.title}`
                        : note.sceneId}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="shrink-0">
                      项目整体
                    </Badge>
                  )}
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {note.text}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
