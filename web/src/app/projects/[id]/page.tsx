"use client";

/**
 * Project detail page — `/projects/[id]`.
 *
 * Two-column layout:
 *   - Left (sticky): project title + project id, back link to `/projects`,
 *     and the vertical `StagePanel` showing all 8 stages.
 *   - Right: a 6-tab container (Brief / Storyboard / HTML / Audio /
 *     Render / QA).
 *
 * Data flow:
 *   - Client-side fetch of `GET /api/projects/{id}` on mount.
 *   - Polls every 5 seconds so the page reflects stage progress driven by
 *     server-side tasks without requiring a manual refresh. Req 17.2
 *     mandates "3 秒内反映" on the list page; a 5 s poll here keeps the
 *     detail page close to that while keeping server cost low.
 *   - Polling pauses whenever the `SceneDrawer` is open so in-flight user
 *     edits aren't overwritten by a mid-edit refetch.
 *
 * Error handling:
 *   - 404 → dedicated not-found page (Next.js route segment).
 *   - Non-2xx other → inline error card with a link back to `/projects`.
 *   - Network failure → same inline error card, retry is implicit via
 *     the next poll tick.
 *
 * _Requirements: 12.1, 12.2, 12.12, 17.1, 17.2_
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { notFound } from "next/navigation";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SceneDrawer } from "@/components/workbench/scene-drawer";
import { StagePanel } from "@/components/workbench/stage-panel";
import { AudioTab } from "@/components/workbench/tabs/audio-tab";
import { BriefTab } from "@/components/workbench/tabs/brief-tab";
import { HtmlTab } from "@/components/workbench/tabs/html-tab";
import { QaTab } from "@/components/workbench/tabs/qa-tab";
import { RenderTab } from "@/components/workbench/tabs/render-tab";
import { StoryboardTab } from "@/components/workbench/tabs/storyboard-tab";
import type { ErrorResponse, Project, Scene } from "@/lib/workbench/types";

const POLL_INTERVAL_MS = 5_000;

type FetchState =
  | { kind: "loading" }
  | { kind: "ok"; project: Project }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

export default function ProjectDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [activeScene, setActiveScene] = useState<Scene | null>(null);

  // -----------------------------------------------------------------------
  // Fetch + polling
  // -----------------------------------------------------------------------
  //
  // Polling is paused while a scene drawer is open — `activeScene` is part
  // of the dependency array below so the effect re-runs (clearing its old
  // interval) whenever the drawer opens or closes.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
          method: "GET",
          cache: "no-store",
        });
        if (cancelled) return;

        if (res.status === 404) {
          setState({ kind: "not-found" });
          return;
        }
        if (!res.ok) {
          let message = `读取失败 (${res.status})`;
          try {
            const payload = (await res.json()) as ErrorResponse;
            if (payload?.error?.message) message = payload.error.message;
          } catch {
            // ignore body parse errors
          }
          setState({ kind: "error", message });
          return;
        }

        const project = (await res.json()) as Project;
        if (cancelled) return;
        setState({ kind: "ok", project });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "读取失败，请稍后重试",
        });
      }
    };

    void load();

    // Pause polling while the scene drawer is open to avoid overwriting
    // in-flight local edits.
    if (activeScene) {
      return () => {
        cancelled = true;
      };
    }

    const interval = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [id, activeScene]);

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const handleProjectChanged = useCallback((next: Project) => {
    setState({ kind: "ok", project: next });
  }, []);

  const handleSceneOpen = useCallback((scene: Scene) => {
    setActiveScene(scene);
  }, []);

  const handleSceneDrawerClose = useCallback(() => {
    setActiveScene(null);
  }, []);

  const handleSceneUpdated = useCallback((scene: Scene) => {
    // Merge the updated scene into the project state so the drawer's
    // optimistic updates are reflected immediately. The next poll will
    // supersede this with the server's full view.
    setState((prev) => {
      if (prev.kind !== "ok" || !prev.project.storyboard) return prev;
      const nextScenes = prev.project.storyboard.scenes.map((s) =>
        s.sceneId === scene.sceneId ? scene : s,
      );
      return {
        kind: "ok",
        project: {
          ...prev.project,
          storyboard: { ...prev.project.storyboard, scenes: nextScenes },
        },
      };
    });
  }, []);

  // -----------------------------------------------------------------------
  // Trigger Next.js 404 route when the server confirms the project is gone.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (state.kind === "not-found") {
      notFound();
    }
  }, [state.kind]);

  // -----------------------------------------------------------------------
  // Render states
  // -----------------------------------------------------------------------

  if (state.kind === "loading") {
    return <LoadingSkeleton />;
  }

  if (state.kind === "error") {
    return <ErrorCard message={state.message} />;
  }

  if (state.kind === "not-found") {
    // `notFound()` triggers the route segment; render nothing to avoid a
    // brief flash of the error card between state transitions.
    return <LoadingSkeleton />;
  }

  const project = state.project;

  return (
    <main className="flex-1 px-6 py-8">
      <div className="mx-auto w-full max-w-6xl">
        <div className="flex flex-col gap-6 lg:flex-row">
          <ProjectSidebar project={project} />
          <ProjectTabs
            project={project}
            onProjectChanged={handleProjectChanged}
            onSceneOpen={handleSceneOpen}
          />
        </div>
      </div>

      <SceneDrawer
        scene={activeScene}
        projectId={project.projectId}
        onClose={handleSceneDrawerClose}
        onSceneUpdated={handleSceneUpdated}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Sidebar — sticky column with back link, project meta, and StagePanel.
// ---------------------------------------------------------------------------

function ProjectSidebar({
  project,
}: {
  project: Project;
}): React.JSX.Element {
  return (
    <aside className="w-full shrink-0 lg:sticky lg:top-6 lg:w-64 lg:self-start">
      <Link
        href="/projects"
        className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
      >
        ← 返回项目列表
      </Link>

      <div className="mt-4 space-y-1">
        <h1 className="text-lg font-semibold tracking-tight" title={project.title}>
          {project.title}
        </h1>
        <p className="truncate text-xs text-muted-foreground" title={project.projectId}>
          {project.projectId}
        </p>
      </div>

      <div className="mt-6">
        <StagePanel
          stages={project.stageStatus}
          currentStage={project.stage}
        />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Tabs — six tabs rendered as a single controlled Tabs component.
// ---------------------------------------------------------------------------

const TAB_VALUES = [
  { value: "brief", label: "Brief" },
  { value: "storyboard", label: "Storyboard" },
  { value: "html", label: "HTML" },
  { value: "audio", label: "Audio" },
  { value: "render", label: "Render" },
  { value: "qa", label: "QA" },
] as const;

function ProjectTabs({
  project,
  onProjectChanged,
  onSceneOpen,
}: {
  project: Project;
  onProjectChanged: (p: Project) => void;
  onSceneOpen: (s: Scene) => void;
}): React.JSX.Element {
  // Memoize so switching tabs doesn't needlessly re-mount inner tab panels.
  const triggers = useMemo(
    () =>
      TAB_VALUES.map((t) => (
        <TabsTrigger key={t.value} value={t.value}>
          {t.label}
        </TabsTrigger>
      )),
    [],
  );

  return (
    <section className="min-w-0 flex-1">
      <Tabs defaultValue="brief" className="flex flex-col gap-4">
        <TabsList className="w-full justify-start overflow-x-auto">
          {triggers}
        </TabsList>

        <TabsContent value="brief">
          <BriefTab project={project} onProjectChanged={onProjectChanged} />
        </TabsContent>
        <TabsContent value="storyboard">
          <StoryboardTab
            project={project}
            onProjectChanged={onProjectChanged}
            onSceneOpen={onSceneOpen}
          />
        </TabsContent>
        <TabsContent value="html">
          <HtmlTab project={project} onProjectChanged={onProjectChanged} />
        </TabsContent>
        <TabsContent value="audio">
          <AudioTab project={project} onProjectChanged={onProjectChanged} />
        </TabsContent>
        <TabsContent value="render">
          <RenderTab project={project} onProjectChanged={onProjectChanged} />
        </TabsContent>
        <TabsContent value="qa">
          <QaTab project={project} onProjectChanged={onProjectChanged} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

function LoadingSkeleton(): React.JSX.Element {
  return (
    <main className="flex-1 px-6 py-8" aria-label="加载项目详情" aria-busy>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 lg:flex-row">
        <aside className="w-full lg:w-64">
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          <div className="mt-4 space-y-2">
            <div className="h-5 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          </div>
          <div className="mt-6 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        </aside>
        <section className="min-w-0 flex-1">
          <div className="mb-4 h-8 w-full max-w-md animate-pulse rounded bg-muted" />
          <div className="h-64 w-full animate-pulse rounded-lg bg-muted" />
        </section>
      </div>
    </main>
  );
}

function ErrorCard({ message }: { message: string }): React.JSX.Element {
  return (
    <main className="flex-1 px-6 py-16">
      <div
        className="mx-auto flex max-w-lg flex-col items-center gap-4 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center"
        role="alert"
      >
        <h1 className="text-base font-semibold text-destructive">
          项目不存在或无法读取
        </h1>
        <p className="text-sm text-muted-foreground">{message}</p>
        <Link
          href="/projects"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          ← 返回项目列表
        </Link>
      </div>
    </main>
  );
}
