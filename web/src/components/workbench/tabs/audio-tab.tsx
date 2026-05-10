"use client";

/**
 * AudioTab — per-scene TTS status + batch & per-scene regenerate actions,
 * plus a global voice picker that bulk-updates every scene's voice in a
 * single click.
 *
 * Each row shows:
 *   - scene index / title
 *   - narration preview
 *   - voice badge (reflects the current per-scene voice — after a bulk
 *     update every badge shows the new uniform voice)
 *   - TTS status chip (未生成 / 已生成 / 失败 / 生成中)
 *   - "重新生成 TTS" per-scene button
 *   - inline `<audio controls>` player when the scene has a generated mp3
 *
 * Top-bar actions (two rows):
 *   Row 1 — **Global voice picker**:
 *     - `<select>` with the 7 curated `VOICES` + "其他 (自定义)…". The
 *       default selection is the shared scene voice when every scene
 *       agrees on one, otherwise `DEFAULT_VOICE`. Non-curated uniform
 *       voices fall through to the custom branch with the value
 *       pre-filled in the free-text input.
 *     - `应用到所有场景` button → `ConfirmDialog` → **one** POST to
 *       `/api/projects/{id}/scenes/bulk-voice` with `{ voice }`. The
 *       server runs every scene's voice update inside a single lock
 *       acquisition and a single atomic write, so the response is
 *       either total success or total failure — never partial. This
 *       replaces the earlier N-PATCH fan-out that race-lost
 *       `LOCK_BUSY` on every sibling request (bug repro:
 *       `proj_1778375317741_8af0bd`). Success banner carries the
 *       `updatedCount` the server reports; failure banner shows the
 *       single error envelope (no per-scene list — the write is
 *       atomic, nothing was persisted on error).
 *
 *   Row 2 — existing controls:
 *     - Scene count / ready count line.
 *     - "生成全部 Audio" → `POST .../audio/generate` (force omitted so
 *       existing mp3s are skipped). Surfaces partial failures from a
 *       207 response inline.
 *
 * Inline player: scenes with `audioPath` render an `<audio controls
 * preload="metadata">` whose `src` points at
 * `/api/projects/{id}/audio/scenes/{index}` (Range-enabled route), so the
 * browser only fetches mp3 bytes when the user hits play. The `key`
 * includes `scene.updatedAt` so a regenerated mp3 forces the element to
 * remount and bust the media cache.
 */

import { useCallback, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StageFailureBanner } from "@/components/workbench/stage-failure-banner";
import {
  ConfirmDialog,
  EmptyStateCard,
  extractErrorMessage,
} from "@/components/workbench/tabs/_shared";
import { DEFAULT_VOICE, VOICES } from "@/lib/workbench/constants";
import { canEnterTab, requiredStageForTab } from "@/lib/workbench/tab-gating";
import type { Project, Scene, TTSBatchResult, Voice } from "@/lib/workbench/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AudioTabProps {
  project: Project;
  onProjectChanged: (project: Project) => void;
}

const NARRATION_PREVIEW_MAX = 60;

/** Sentinel value for the "其他 (自定义)…" <option>. Never a real voice. */
const CUSTOM_OPTION = "__custom__" as const;

type SceneStatus = "missing" | "ready" | "failed" | "pending";

interface FailureDetail {
  index: number;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Compute the voice the picker should initialise to. When every scene
 * agrees on one voice, use that. Otherwise fall back to `DEFAULT_VOICE`.
 */
function initialPickerVoice(scenes: readonly Scene[]): Voice {
  if (scenes.length === 0) return DEFAULT_VOICE;
  const first = scenes[0].voice;
  const allSame = scenes.every((s) => s.voice === first);
  return allSame ? first : DEFAULT_VOICE;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AudioTab({
  project,
  onProjectChanged,
}: AudioTabProps): React.JSX.Element {
  const scenes = project.storyboard?.scenes ?? [];

  // -----------------------------------------------------------------------
  // Voice-picker state
  //
  // The picker has two moving parts:
  //   - `selectValue`: which <option> is selected (one of VOICES, or the
  //     CUSTOM sentinel).
  //   - `customVoice`: the free-text fallback, used only when the user
  //     picked "其他 (自定义)…". Kept in state so editing doesn't flicker.
  //
  // Initial state is derived ONCE from the scenes via lazy `useState`
  // initialisers. The picker is intentionally NOT resynced when
  // `scenes` changes — that would fight user input during an in-flight
  // update. If Dale wants to re-derive from the current scenes after a
  // refetch, a future enhancement could add a "reset to scene voice"
  // affordance; for now the initial mount read is enough.
  // -----------------------------------------------------------------------
  const [selectValue, setSelectValue] = useState<string>(() => {
    const initial = initialPickerVoice(scenes);
    return (VOICES as readonly string[]).includes(initial)
      ? initial
      : CUSTOM_OPTION;
  });
  const [customVoice, setCustomVoice] = useState<string>(() => {
    const initial = initialPickerVoice(scenes);
    return (VOICES as readonly string[]).includes(initial) ? "" : initial;
  });

  const isCustomSelected = selectValue === CUSTOM_OPTION;
  const effectiveVoice = isCustomSelected ? customVoice.trim() : selectValue;
  const applyDisabled = effectiveVoice.length === 0 || scenes.length === 0;

  // Bulk-update flow state.
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkSuccessMsg, setBulkSuccessMsg] = useState<string | null>(null);
  const [bulkErrorMsg, setBulkErrorMsg] = useState<string | null>(null);

  // Per-row TTS / batch state.
  const [batchPending, setBatchPending] = useState(false);
  const [sceneRequestIds, setSceneRequestIds] = useState<Record<string, true>>(
    {},
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [failures, setFailures] = useState<FailureDetail[]>([]);

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------
  const runBatch = useCallback(async () => {
    setBatchPending(true);
    setActionError(null);
    setFailures([]);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.projectId)}/audio/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (res.status === 207) {
        const body = (await res.json()) as {
          project: Project;
          failures: TTSBatchResult["failures"];
        };
        onProjectChanged(body.project);
        setFailures(
          body.failures.map((f) => ({
            index: f.index,
            code: f.error.code,
            message: f.error.message,
          })),
        );
        return;
      }
      if (!res.ok) {
        const msg = await extractErrorMessage(res, "生成音频失败");
        setActionError(msg);
        return;
      }
      const updated = (await res.json()) as Project;
      onProjectChanged(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "生成音频失败");
    } finally {
      setBatchPending(false);
    }
  }, [project.projectId, onProjectChanged]);

  const runSceneTts = useCallback(
    async (scene: Scene) => {
      setSceneRequestIds((prev) => ({ ...prev, [scene.sceneId]: true }));
      setActionError(null);
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(project.projectId)}/scenes/${encodeURIComponent(scene.sceneId)}/tts`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        if (!res.ok) {
          const msg = await extractErrorMessage(res, "TTS 生成失败");
          setActionError(`Scene ${scene.index}: ${msg}`);
          return;
        }
        // The scene route returns the updated Scene; refresh the project
        // from the server so every caller sees consistent data (including
        // stageStatus, artifact paths, etc.).
        const projRes = await fetch(
          `/api/projects/${encodeURIComponent(project.projectId)}`,
          { method: "GET" },
        );
        if (projRes.ok) {
          const updated = (await projRes.json()) as Project;
          onProjectChanged(updated);
          // Clear any stale failure entry for this scene index.
          setFailures((prev) => prev.filter((f) => f.index !== scene.index));
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "TTS 生成失败");
      } finally {
        setSceneRequestIds((prev) => {
          const next = { ...prev };
          delete next[scene.sceneId];
          return next;
        });
      }
    },
    [project.projectId, onProjectChanged],
  );

  const runBulkVoiceUpdate = useCallback(async () => {
    if (applyDisabled) return;
    const voice = effectiveVoice;
    setBulkPending(true);
    setBulkSuccessMsg(null);
    setBulkErrorMsg(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.projectId)}/scenes/bulk-voice`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voice }),
        },
      );

      if (!res.ok) {
        // Bulk write is atomic: a non-2xx means nothing was persisted,
        // so we surface a single error banner rather than a per-scene
        // failure list. The envelope comes straight from `respondError`.
        const msg = await extractErrorMessage(res, "批量更新声线失败");
        setBulkErrorMsg(msg);
        return;
      }

      const body = (await res.json()) as {
        project: Project;
        updatedCount: number;
      };
      onProjectChanged(body.project);
      setBulkSuccessMsg(
        `已将 ${body.updatedCount} 个场景更新为 ${voice}。点击「生成全部 Audio」以重新生成音频。`,
      );
    } catch (err) {
      setBulkErrorMsg(
        err instanceof Error ? err.message : "批量更新声线失败",
      );
    } finally {
      setBulkPending(false);
      setBulkConfirmOpen(false);
    }
  }, [
    applyDisabled,
    effectiveVoice,
    project.projectId,
    onProjectChanged,
  ]);

  // -----------------------------------------------------------------------
  // Gating
  // -----------------------------------------------------------------------
  if (!canEnterTab("audio", project.stage)) {
    return (
      <EmptyStateCard
        tab="audio"
        requiredStage={requiredStageForTab("audio")}
        currentStage={project.stage}
      />
    );
  }

  const audioError = project.stageStatus.audio.error;
  const audioFailed =
    project.stageStatus.audio.status === "failed" && audioError !== undefined;

  const failureByIndex = new Map<number, FailureDetail>();
  for (const f of failures) failureByIndex.set(f.index, f);

  function statusOf(scene: Scene): SceneStatus {
    if (sceneRequestIds[scene.sceneId]) return "pending";
    if (failureByIndex.has(scene.index)) return "failed";
    if (scene.audioPath && scene.audioPath.length > 0) return "ready";
    return "missing";
  }

  return (
    <div className="flex flex-col gap-4">
      {audioFailed && audioError ? (
        <StageFailureBanner
          projectId={project.projectId}
          stage="audio"
          error={audioError}
        />
      ) : null}

      {/* Row 1 — global voice picker */}
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor="audio-tab-voice-picker"
          className="text-sm font-medium text-foreground"
        >
          Voice:
        </label>
        <select
          id="audio-tab-voice-picker"
          aria-label="Voice"
          value={selectValue}
          onChange={(e) => {
            setSelectValue(e.target.value);
            // Clear stale banners when the user starts composing a new selection.
            setBulkSuccessMsg(null);
            setBulkErrorMsg(null);
          }}
          disabled={bulkPending}
          className={cn(
            "h-8 min-w-[260px] rounded-lg border border-input bg-transparent px-2 text-sm transition-colors outline-none",
            "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            "dark:bg-input/30",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {VOICES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
          <option value={CUSTOM_OPTION}>其他 (自定义)…</option>
        </select>
        {isCustomSelected ? (
          <Input
            aria-label="自定义 Azure voice name"
            placeholder="Azure voice name, e.g. zh-CN-XiaoyiNeural"
            value={customVoice}
            maxLength={200}
            disabled={bulkPending}
            onChange={(e) => {
              setCustomVoice(e.target.value);
              setBulkSuccessMsg(null);
              setBulkErrorMsg(null);
            }}
            className="h-8 w-[260px] text-sm"
          />
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setBulkConfirmOpen(true)}
          disabled={applyDisabled || bulkPending || batchPending}
        >
          {bulkPending ? "应用中…" : "应用到所有场景"}
        </Button>
      </div>

      {/* Row 2 — scene count + batch TTS */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          共 {scenes.length} 个场景，
          <span className="font-medium text-foreground">
            {scenes.filter((s) => s.audioPath).length}
          </span>{" "}
          个已生成。
        </div>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => {
            void runBatch();
          }}
          disabled={batchPending || scenes.length === 0 || bulkPending}
        >
          {batchPending ? "生成中…" : "生成全部 Audio"}
        </Button>
      </div>

      {bulkSuccessMsg ? (
        <div
          role="status"
          className="rounded-md border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
        >
          {bulkSuccessMsg}
        </div>
      ) : null}

      {bulkErrorMsg ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {bulkErrorMsg}
        </div>
      ) : null}

      {actionError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </div>
      ) : null}

      {scenes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          暂无场景。请先生成 Storyboard。
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {scenes.map((scene) => {
            const status = statusOf(scene);
            const failure = failureByIndex.get(scene.index);
            const scenePending = Boolean(sceneRequestIds[scene.sceneId]);
            return (
              <li
                key={scene.sceneId}
                className="rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                    {scene.index}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {scene.title}
                      </span>
                      <Badge variant="outline" className="shrink-0">
                        {scene.voice}
                      </Badge>
                      <StatusChip status={status} />
                    </div>
                    <span className="truncate text-xs text-muted-foreground">
                      {truncateNarration(scene.narration)}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void runSceneTts(scene);
                    }}
                    disabled={scenePending || batchPending || bulkPending}
                  >
                    {scenePending ? "生成中…" : "重新生成 TTS"}
                  </Button>
                </div>
                {failure ? (
                  <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
                    <span className="font-mono font-medium">
                      {failure.code}
                    </span>{" "}
                    · {failure.message}
                  </p>
                ) : null}
                {scene.audioPath && scene.audioPath.length > 0 ? (
                  <audio
                    key={`${scene.audioPath}-${scene.updatedAt ?? ""}`}
                    controls
                    preload="metadata"
                    src={`/api/projects/${encodeURIComponent(project.projectId)}/audio/scenes/${scene.index}?v=${encodeURIComponent(scene.updatedAt ?? "")}`}
                    className="mt-2 w-full"
                    aria-label={`Scene ${scene.index} audio`}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={bulkConfirmOpen}
        title="应用到所有场景？"
        description={
          <>
            将把所有 <span className="font-medium">{scenes.length}</span> 个场景的
            voice 改为「
            <span className="font-mono font-medium">{effectiveVoice}</span>
            」，已生成的音频会被清除，需要重新运行「生成全部 Audio」。确认继续？
          </>
        }
        confirmLabel="确认应用"
        destructive
        busy={bulkPending}
        onConfirm={() => {
          void runBulkVoiceUpdate();
        }}
        onCancel={() => {
          if (!bulkPending) setBulkConfirmOpen(false);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateNarration(text: string): string {
  if (text.length <= NARRATION_PREVIEW_MAX) return text;
  return text.slice(0, NARRATION_PREVIEW_MAX - 1) + "…";
}

function StatusChip({ status }: { status: SceneStatus }): React.JSX.Element {
  const styles: Record<SceneStatus, { label: string; className: string }> = {
    missing: {
      label: "未生成",
      className: "bg-muted text-muted-foreground",
    },
    ready: {
      label: "已生成",
      className:
        "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20",
    },
    failed: {
      label: "失败",
      className:
        "bg-destructive/10 text-destructive border border-destructive/20",
    },
    pending: {
      label: "生成中",
      className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20",
    },
  };
  const s = styles[status];
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}
