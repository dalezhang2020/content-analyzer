"use client";

/**
 * SceneDrawer — right-side drawer for editing a single Scene.
 *
 * Wraps the three scene-level operations defined by Requirement 13:
 *   1. `保存` → `PATCH /api/projects/{id}/scenes/{sceneId}` with the
 *      editable subset (`title`, `narration`, `durationSec`, `voice`,
 *      `qaNote`).
 *   2. `重新生成 TTS` → `POST /api/projects/{id}/scenes/{sceneId}/tts`.
 *      Keeps the drawer open; surfaces success / failure as an inline
 *      status line (MVP-simple, no toast library yet).
 *   3. `基于 QA note 重写 Scene` → `POST /api/projects/{id}/scenes/
 *      {sceneId}/rewrite` with the current `qaNote`. Success flips the
 *      drawer body into a diff view (`DiffView`) so the user can
 *      explicitly accept or discard the rewritten narration + duration.
 *
 * Client-side validation mirrors the zod constraints used by the API so
 * we fail fast and don't round-trip obviously-bad input. The server is
 * still the source of truth; server errors are rendered inline.
 *
 * _Requirements: 13.1–13.10_
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type React from "react";

import { DiffView } from "@/components/workbench/diff-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LIMITS, VOICES } from "@/lib/workbench/constants";
import type { Scene, Voice } from "@/lib/workbench/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SceneDrawerProps {
  /** Scene currently under edit. When `null`, the drawer is closed. */
  scene: Scene | null;
  projectId: string;
  onClose: () => void;
  /**
   * Called after any server mutation (save, TTS regenerate, rewrite
   * accept) completes successfully so the parent can refresh its copy
   * of the project.
   */
  onSceneUpdated: (scene: Scene) => void;
}

interface EditableFields {
  title: string;
  narration: string;
  durationSec: number;
  voice: Voice;
  qaNote: string;
}

type ActionKey = "save" | "tts" | "rewrite";
type ActionState = Partial<Record<ActionKey, boolean>>;
type ErrorState = Partial<Record<ActionKey | "form", string | null>>;

interface RewriteResult {
  before: string;
  after: string;
  afterDurationSec: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFields(scene: Scene): EditableFields {
  return {
    title: scene.title,
    narration: scene.narration,
    durationSec: scene.durationSec,
    voice: scene.voice,
    qaNote: scene.qaNote,
  };
}

/**
 * Compact client-side validator. Returns a map from field name to the
 * first error message found, or `null` when every field is valid.
 * Keep in lockstep with `SceneEditableSchema` on the server.
 */
function validateFields(fields: EditableFields): Record<string, string> | null {
  const errs: Record<string, string> = {};

  const title = fields.title.trim();
  if (title.length < 1 || title.length > LIMITS.SCENE_TITLE_MAX) {
    errs.title = `标题需在 1–${LIMITS.SCENE_TITLE_MAX} 字符之间`;
  }

  const narration = fields.narration;
  if (
    narration.length < 1 ||
    narration.length > LIMITS.SCENE_NARRATION_MAX_POST_REWRITE
  ) {
    errs.narration = `文案需在 1–${LIMITS.SCENE_NARRATION_MAX_POST_REWRITE} 字符之间`;
  }

  if (
    !Number.isInteger(fields.durationSec) ||
    fields.durationSec < LIMITS.SCENE_DURATION_MIN ||
    fields.durationSec > LIMITS.SCENE_DURATION_MAX
  ) {
    errs.durationSec = `时长需为 ${LIMITS.SCENE_DURATION_MIN}–${LIMITS.SCENE_DURATION_MAX} 之间的整数`;
  }

  if (!(VOICES as readonly string[]).includes(fields.voice)) {
    errs.voice = "voice 取值非法";
  }

  if (fields.qaNote.length > LIMITS.QA_NOTE_MAX) {
    errs.qaNote = `QA note 长度不能超过 ${LIMITS.QA_NOTE_MAX} 字符`;
  }

  return Object.keys(errs).length > 0 ? errs : null;
}

/**
 * Extract a human-readable message from a canonical error-envelope
 * response. Falls back to `defaultMsg` when the body isn't the expected
 * shape.
 */
async function extractErrorMessage(
  res: Response,
  defaultMsg: string,
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
    // fall through to default
  }
  return defaultMsg;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SceneDrawer({
  scene,
  projectId,
  onClose,
  onSceneUpdated,
}: SceneDrawerProps): React.JSX.Element | null {
  // All hooks must run unconditionally. We store the currently-edited
  // fields + derived state even when `scene` is null so React's hook
  // ordering stays stable across open/close cycles.
  const titleId = useId();
  const narrationId = useId();
  const durationId = useId();
  const voiceId = useId();
  const qaNoteId = useId();

  const [fields, setFields] = useState<EditableFields | null>(
    scene ? toFields(scene) : null,
  );
  const [pending, setPending] = useState<ActionState>({});
  const [errors, setErrors] = useState<ErrorState>({});
  const [ttsMessage, setTtsMessage] = useState<string | null>(null);
  const [rewrite, setRewrite] = useState<RewriteResult | null>(null);

  // Latest scene snapshot accepted as "truth" (for rewrite revert + ESC
  // close diff view).
  const sceneRef = useRef<Scene | null>(scene);
  sceneRef.current = scene;

  // Reset all state when the active scene changes (including open /
  // close transitions). Otherwise stale edits from a previously-open
  // scene would leak into the new one.
  useEffect(() => {
    setFields(scene ? toFields(scene) : null);
    setPending({});
    setErrors({});
    setTtsMessage(null);
    setRewrite(null);
  }, [scene?.sceneId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ESC closes the drawer (but only when no rewrite diff is showing —
  // closing would lose the pending diff, which is user-unfriendly).
  useEffect(() => {
    if (!scene) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !rewrite) {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [scene, rewrite, onClose]);

  const fieldErrors = useMemo(
    () => (fields ? validateFields(fields) : null),
    [fields],
  );

  const qaNoteTrimmed = fields?.qaNote.trim() ?? "";
  const rewriteDisabled =
    qaNoteTrimmed.length === 0 ||
    Boolean(pending.rewrite) ||
    qaNoteTrimmed.length > LIMITS.QA_NOTE_REWRITE_MAX;

  const isAnyActionPending =
    Boolean(pending.save) || Boolean(pending.tts) || Boolean(pending.rewrite);

  // -----------------------------------------------------------------------
  // Action handlers
  // -----------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!scene || !fields) return;
    const errs = validateFields(fields);
    if (errs) {
      setErrors((prev) => ({
        ...prev,
        form: "请修正表单中的错误后再保存",
      }));
      return;
    }

    setPending((p) => ({ ...p, save: true }));
    setErrors((e) => ({ ...e, save: null, form: null }));

    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(scene.sceneId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: fields.title.trim(),
            narration: fields.narration,
            durationSec: fields.durationSec,
            voice: fields.voice,
            qaNote: fields.qaNote,
          }),
        },
      );

      if (!res.ok) {
        const msg = await extractErrorMessage(res, "保存失败");
        setErrors((e) => ({ ...e, save: msg }));
        return;
      }

      const updated = (await res.json()) as Scene;
      onSceneUpdated(updated);
      onClose();
    } catch (err) {
      setErrors((e) => ({
        ...e,
        save: err instanceof Error ? err.message : "保存失败",
      }));
    } finally {
      setPending((p) => ({ ...p, save: false }));
    }
  }, [scene, fields, projectId, onSceneUpdated, onClose]);

  const handleRegenerateTts = useCallback(async () => {
    if (!scene) return;
    setPending((p) => ({ ...p, tts: true }));
    setErrors((e) => ({ ...e, tts: null }));
    setTtsMessage(null);

    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(scene.sceneId)}/tts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        },
      );

      if (!res.ok) {
        const msg = await extractErrorMessage(res, "TTS 生成失败");
        setErrors((e) => ({ ...e, tts: msg }));
        return;
      }

      const updated = (await res.json()) as Scene;
      onSceneUpdated(updated);
      setTtsMessage("TTS 已重新生成");
      // Keep drawer open per Req 13.6. Don't blow away edited fields —
      // only refresh non-editable server-owned bits (audioPath etc.).
      setFields((prev) =>
        prev
          ? {
              ...prev,
              // Server decides final narration/voice after TTS? Usually
              // no — but mirror them just in case.
              narration: updated.narration,
              durationSec: updated.durationSec,
              voice: updated.voice,
            }
          : prev,
      );
    } catch (err) {
      setErrors((e) => ({
        ...e,
        tts: err instanceof Error ? err.message : "TTS 生成失败",
      }));
    } finally {
      setPending((p) => ({ ...p, tts: false }));
    }
  }, [scene, projectId, onSceneUpdated]);

  const handleRewrite = useCallback(async () => {
    if (!scene || !fields) return;
    if (qaNoteTrimmed.length === 0) return;

    setPending((p) => ({ ...p, rewrite: true }));
    setErrors((e) => ({ ...e, rewrite: null }));

    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(scene.sceneId)}/rewrite`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ qaNote: qaNoteTrimmed }),
        },
      );

      if (!res.ok) {
        const msg = await extractErrorMessage(res, "改写失败");
        setErrors((e) => ({ ...e, rewrite: msg }));
        return;
      }

      // Shape: { scene: Scene, compositionRegenRequired: boolean }.
      // The server already persisted the rewritten scene before
      // responding, so an "accept" path simply keeps that state and a
      // "discard" path must PATCH back to the pre-rewrite values.
      const body = (await res.json()) as {
        scene: Scene;
        compositionRegenRequired?: boolean;
      };

      setRewrite({
        before: scene.narration,
        after: body.scene.narration,
        afterDurationSec: body.scene.durationSec,
      });
      onSceneUpdated(body.scene);
    } catch (err) {
      setErrors((e) => ({
        ...e,
        rewrite: err instanceof Error ? err.message : "改写失败",
      }));
    } finally {
      setPending((p) => ({ ...p, rewrite: false }));
    }
  }, [scene, fields, projectId, qaNoteTrimmed, onSceneUpdated]);

  const handleAcceptRewrite = useCallback(() => {
    if (!rewrite) return;
    // Server already persisted the rewrite, so "accept" is purely a
    // UI-side confirmation: adopt the new narration/duration into the
    // editable field state and dismiss the diff.
    setFields((prev) =>
      prev
        ? {
            ...prev,
            narration: rewrite.after,
            durationSec: rewrite.afterDurationSec,
          }
        : prev,
    );
    setRewrite(null);
  }, [rewrite]);

  const handleDiscardRewrite = useCallback(async () => {
    if (!rewrite || !scene) return;
    // Revert server state back to the pre-rewrite narration/duration.
    setPending((p) => ({ ...p, rewrite: true }));
    setErrors((e) => ({ ...e, rewrite: null }));

    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(scene.sceneId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            narration: rewrite.before,
            durationSec: scene.durationSec,
          }),
        },
      );

      if (!res.ok) {
        const msg = await extractErrorMessage(res, "放弃改写失败");
        setErrors((e) => ({ ...e, rewrite: msg }));
        return;
      }

      const restored = (await res.json()) as Scene;
      onSceneUpdated(restored);
      setFields((prev) =>
        prev
          ? {
              ...prev,
              narration: restored.narration,
              durationSec: restored.durationSec,
            }
          : prev,
      );
      setRewrite(null);
    } catch (err) {
      setErrors((e) => ({
        ...e,
        rewrite: err instanceof Error ? err.message : "放弃改写失败",
      }));
    } finally {
      setPending((p) => ({ ...p, rewrite: false }));
    }
  }, [rewrite, scene, projectId, onSceneUpdated]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (!scene || !fields) return null;

  const visibleErrors: Array<{ key: string; message: string }> = [];
  if (errors.form) visibleErrors.push({ key: "form", message: errors.form });
  if (errors.save) visibleErrors.push({ key: "save", message: errors.save });
  if (errors.tts) visibleErrors.push({ key: "tts", message: errors.tts });
  if (errors.rewrite)
    visibleErrors.push({ key: "rewrite", message: errors.rewrite });

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/50"
        onClick={() => {
          if (!rewrite) onClose();
        }}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`编辑 Scene ${scene.index}`}
        className="fixed top-0 right-0 z-40 h-full w-[480px] max-w-full overflow-y-auto border-l bg-background shadow-xl"
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">
              Scene {scene.index}
            </h2>
            <p className="text-xs text-muted-foreground">{scene.sceneId}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!rewrite) onClose();
            }}
            disabled={Boolean(rewrite)}
          >
            关闭
          </Button>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4">
          {visibleErrors.length > 0 && (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {visibleErrors.map((e) => (
                <p key={e.key} className="leading-snug">
                  {e.message}
                </p>
              ))}
            </div>
          )}

          {ttsMessage && !errors.tts && (
            <div
              className="rounded-md border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
              role="status"
            >
              {ttsMessage}
            </div>
          )}

          {rewrite ? (
            <DiffView
              before={rewrite.before}
              after={rewrite.after}
              onAccept={handleAcceptRewrite}
              onDiscard={() => {
                void handleDiscardRewrite();
              }}
            />
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSave();
              }}
            >
              {/* title */}
              <Field
                id={titleId}
                label="标题"
                error={fieldErrors?.title}
                hint={`${fields.title.length}/${LIMITS.SCENE_TITLE_MAX}`}
              >
                <Input
                  id={titleId}
                  value={fields.title}
                  maxLength={LIMITS.SCENE_TITLE_MAX}
                  aria-invalid={Boolean(fieldErrors?.title)}
                  onChange={(e) =>
                    setFields((prev) =>
                      prev ? { ...prev, title: e.target.value } : prev,
                    )
                  }
                />
              </Field>

              {/* narration */}
              <Field
                id={narrationId}
                label="文案 (narration)"
                error={fieldErrors?.narration}
                hint={`${fields.narration.length}/${LIMITS.SCENE_NARRATION_MAX_POST_REWRITE}`}
              >
                <textarea
                  id={narrationId}
                  value={fields.narration}
                  rows={6}
                  maxLength={LIMITS.SCENE_NARRATION_MAX_POST_REWRITE}
                  aria-invalid={Boolean(fieldErrors?.narration)}
                  onChange={(e) =>
                    setFields((prev) =>
                      prev ? { ...prev, narration: e.target.value } : prev,
                    )
                  }
                  className={cn(
                    "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none",
                    "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                    "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
                    "dark:bg-input/30",
                  )}
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                {/* durationSec */}
                <Field
                  id={durationId}
                  label="时长 (秒)"
                  error={fieldErrors?.durationSec}
                >
                  <Input
                    id={durationId}
                    type="number"
                    inputMode="numeric"
                    min={LIMITS.SCENE_DURATION_MIN}
                    max={LIMITS.SCENE_DURATION_MAX}
                    step={1}
                    value={Number.isFinite(fields.durationSec) ? fields.durationSec : ""}
                    aria-invalid={Boolean(fieldErrors?.durationSec)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const parsed = raw === "" ? Number.NaN : Number.parseInt(raw, 10);
                      setFields((prev) =>
                        prev ? { ...prev, durationSec: parsed } : prev,
                      );
                    }}
                  />
                </Field>

                {/* voice */}
                <Field id={voiceId} label="Voice" error={fieldErrors?.voice}>
                  <select
                    id={voiceId}
                    value={fields.voice}
                    aria-invalid={Boolean(fieldErrors?.voice)}
                    onChange={(e) =>
                      setFields((prev) =>
                        prev
                          ? { ...prev, voice: e.target.value as Voice }
                          : prev,
                      )
                    }
                    className={cn(
                      "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm transition-colors outline-none",
                      "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                      "dark:bg-input/30",
                    )}
                  >
                    {VOICES.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              {/* qaNote */}
              <Field
                id={qaNoteId}
                label="QA Note"
                error={fieldErrors?.qaNote}
                hint={`${fields.qaNote.length}/${LIMITS.QA_NOTE_MAX}`}
              >
                <textarea
                  id={qaNoteId}
                  value={fields.qaNote}
                  rows={4}
                  maxLength={LIMITS.QA_NOTE_MAX}
                  aria-invalid={Boolean(fieldErrors?.qaNote)}
                  onChange={(e) =>
                    setFields((prev) =>
                      prev ? { ...prev, qaNote: e.target.value } : prev,
                    )
                  }
                  className={cn(
                    "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none",
                    "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                    "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
                    "dark:bg-input/30",
                  )}
                />
              </Field>

              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void handleRegenerateTts();
                  }}
                  disabled={isAnyActionPending}
                >
                  {pending.tts ? "TTS 生成中…" : "重新生成 TTS"}
                </Button>

                {/* The rewrite button carries a native tooltip when
                    disabled because qaNote is empty. */}
                <span
                  title={
                    qaNoteTrimmed.length === 0 ? "请先填写 QA note" : undefined
                  }
                >
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      void handleRewrite();
                    }}
                    disabled={rewriteDisabled || isAnyActionPending}
                  >
                    {pending.rewrite ? "改写中…" : "基于 QA note 重写 Scene"}
                  </Button>
                </span>

                <Button
                  type="submit"
                  variant="default"
                  disabled={
                    isAnyActionPending || Boolean(fieldErrors)
                  }
                >
                  {pending.save ? "保存中…" : "保存"}
                </Button>
              </div>
            </form>
          )}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface FieldProps {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
  children: React.ReactNode;
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: FieldProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
        </label>
        {hint && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {hint}
          </span>
        )}
      </div>
      {children}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
