"use client";

/**
 * NewProjectDialog — modal form for creating a new workbench project.
 *
 * Posts to `POST /api/projects` with { title, topic }. On success the parent
 * receives the new projectId via onCreated (parent decides how to navigate).
 * On failure the error is surfaced inline and the form stays open so the
 * user can retry without retyping.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LIMITS } from "@/lib/workbench/constants";
import type { ErrorResponse, Project } from "@/lib/workbench/types";

const TITLE_MAX = LIMITS.PROJECT_TITLE_MAX; // 80
const TOPIC_MAX = LIMITS.TOPIC_MAX; // 500

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}

interface FieldError {
  title: string | null;
  topic: string | null;
}

function validate(title: string, topic: string): FieldError {
  const titleTrimmed = title.trim();
  const topicTrimmed = topic.trim();

  let titleErr: string | null = null;
  if (title.length === 0) {
    titleErr = "标题不能为空";
  } else if (titleTrimmed.length === 0) {
    titleErr = "标题不能仅包含空白字符";
  } else if (titleTrimmed.length > TITLE_MAX) {
    titleErr = `标题最多 ${TITLE_MAX} 个字符`;
  }

  let topicErr: string | null = null;
  if (topic.length === 0) {
    topicErr = "主题不能为空";
  } else if (topicTrimmed.length === 0) {
    topicErr = "主题不能仅包含空白字符";
  } else if (topicTrimmed.length > TOPIC_MAX) {
    topicErr = `主题最多 ${TOPIC_MAX} 个字符`;
  }

  return { title: titleErr, topic: topicErr };
}

export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: NewProjectDialogProps): React.JSX.Element | null {
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [touched, setTouched] = useState<{ title: boolean; topic: boolean }>({
    title: false,
    topic: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const titleId = useId();
  const topicId = useId();
  const titleErrorId = useId();
  const topicErrorId = useId();

  const titleInputRef = useRef<HTMLInputElement>(null);

  // Reset form state whenever the dialog is reopened.
  useEffect(() => {
    if (open) {
      setTitle("");
      setTopic("");
      setTouched({ title: false, topic: false });
      setSubmitting(false);
      setSubmitError(null);
      // Defer autofocus so it happens after the element is actually mounted.
      const h = window.setTimeout(() => titleInputRef.current?.focus(), 0);
      return () => window.clearTimeout(h);
    }
  }, [open]);

  // Close on Escape while not submitting.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  const errors = useMemo(() => validate(title, topic), [title, topic]);
  const hasErrors = errors.title !== null || errors.topic !== null;

  const showTitleError = touched.title && errors.title !== null;
  const showTopicError = touched.topic && errors.topic !== null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Force-mark all fields as touched so errors display on blind submit.
    setTouched({ title: true, topic: true });
    if (hasErrors || submitting) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          topic: topic.trim(),
        }),
      });
      if (!res.ok) {
        let message = `创建失败 (${res.status})`;
        try {
          const payload = (await res.json()) as ErrorResponse;
          if (payload?.error?.message) {
            message = payload.error.message;
          }
        } catch {
          // ignore body parse errors; fall back to status-based message
        }
        setSubmitError(message);
        setSubmitting(false);
        return;
      }
      const project = (await res.json()) as Project;
      onCreated(project.projectId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "创建失败，请稍后重试");
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!submitting) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${titleId}-heading`}
        className="w-full max-w-md space-y-4 rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={`${titleId}-heading`} className="text-lg font-semibold">
          新建项目
        </h3>

        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          <div className="space-y-1.5">
            <label htmlFor={titleId} className="text-xs font-medium">
              标题
              <span className="ml-1 text-muted-foreground">
                (1–{TITLE_MAX})
              </span>
            </label>
            <Input
              id={titleId}
              ref={titleInputRef}
              type="text"
              value={title}
              maxLength={TITLE_MAX * 2}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, title: true }))}
              aria-invalid={showTitleError || undefined}
              aria-describedby={showTitleError ? titleErrorId : undefined}
              disabled={submitting}
              placeholder="例如：AI 编程工具推荐"
            />
            {showTitleError ? (
              <p id={titleErrorId} className="text-xs text-destructive">
                {errors.title}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label htmlFor={topicId} className="text-xs font-medium">
              主题
              <span className="ml-1 text-muted-foreground">
                (1–{TOPIC_MAX})
              </span>
            </label>
            <textarea
              id={topicId}
              value={topic}
              maxLength={TOPIC_MAX * 2}
              onChange={(e) => setTopic(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, topic: true }))}
              aria-invalid={showTopicError || undefined}
              aria-describedby={showTopicError ? topicErrorId : undefined}
              disabled={submitting}
              rows={4}
              placeholder="用一两句话描述想拍什么"
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
            />
            {showTopicError ? (
              <p id={topicErrorId} className="text-xs text-destructive">
                {errors.topic}
              </p>
            ) : null}
          </div>

          {submitError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {submitError}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={submitting || hasErrors}
            >
              {submitting ? "创建中…" : "创建"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
