"use client";

/**
 * Video Creation Workbench — projects list page.
 *
 * Fetches `GET /api/projects` on mount and renders a paginated list of
 * `ProjectSummary` rows. The API already returns newest-first, so we trust
 * that order and apply client-side pagination at 20 per page.
 *
 * Delete flow uses `window.confirm` for MVP and DELETEs via the single
 * project route. On failure the error is shown inline at the top of the
 * list so the user can retry. New project flow mounts `NewProjectDialog`
 * and, on successful create, navigates to `/projects/{id}`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { LIMITS } from "@/lib/workbench/constants";
import type { ErrorResponse, ProjectSummary } from "@/lib/workbench/types";

import { NewProjectDialog } from "./_components/new-project-dialog";
import { ProjectRow } from "./_components/project-row";

const PAGE_SIZE = LIMITS.PROJECTS_PER_PAGE;

export default function ProjectsPage(): React.JSX.Element {
  const router = useRouter();

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Initial fetch. Error state is surfaced inline so the user can see what
  // went wrong; the page does not error-boundary out.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) {
          let message = `加载失败 (${res.status})`;
          try {
            const payload = (await res.json()) as ErrorResponse;
            if (payload?.error?.message) message = payload.error.message;
          } catch {
            // ignore body parse errors
          }
          if (!cancelled) {
            setError(message);
            setProjects([]);
          }
          return;
        }
        const data = (await res.json()) as ProjectSummary[];
        if (!cancelled) setProjects(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载失败，请刷新重试");
          setProjects([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Pagination math. Trust the API order (newest-first) — no re-sort here.
  const totalPages = useMemo(() => {
    if (!projects || projects.length === 0) return 1;
    return Math.ceil(projects.length / PAGE_SIZE);
  }, [projects]);

  // Clamp currentPage whenever the list shrinks (e.g. after a delete) so
  // we never land on an empty page beyond the new last page.
  useEffect(() => {
    if (currentPage > totalPages - 1) {
      setCurrentPage(Math.max(0, totalPages - 1));
    }
  }, [currentPage, totalPages]);

  const visibleProjects = useMemo(() => {
    if (!projects) return [];
    const start = currentPage * PAGE_SIZE;
    return projects.slice(start, start + PAGE_SIZE);
  }, [projects, currentPage]);

  const handleCreated = useCallback(
    (projectId: string) => {
      setDialogOpen(false);
      router.push(`/projects/${projectId}`);
    },
    [router],
  );

  const handleDelete = useCallback(
    async (project: ProjectSummary) => {
      if (deleting) return;
      const ok = window.confirm(
        `确认删除『${project.title}』？此操作不可恢复。`,
      );
      if (!ok) return;

      setDeleting(true);
      setDeleteError(null);
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(project.projectId)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          let message = `删除失败 (${res.status})`;
          try {
            const payload = (await res.json()) as ErrorResponse;
            if (payload?.error?.message) message = payload.error.message;
          } catch {
            // ignore parse errors
          }
          setDeleteError(message);
          return;
        }
        setProjects((prev) =>
          prev ? prev.filter((p) => p.projectId !== project.projectId) : prev,
        );
      } catch (err) {
        setDeleteError(
          err instanceof Error ? err.message : "删除失败，请稍后重试",
        );
      } finally {
        setDeleting(false);
      }
    },
    [deleting],
  );

  const showPagination = (projects?.length ?? 0) > PAGE_SIZE;

  return (
    <main className="flex-1 px-6 py-8">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <header className="space-y-3">
          <Link
            href="/"
            className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
          >
            ← 返回 Dashboard
          </Link>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                视频工作台
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                从选题到成片的全流程项目管理。
              </p>
            </div>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              新建项目
            </Button>
          </div>
        </header>

        {/* Inline error banner for initial-load or delete failures. */}
        {error || deleteError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error ?? deleteError}
          </div>
        ) : null}

        {loading ? (
          <ProjectListSkeleton />
        ) : projects && projects.length === 0 ? (
          <EmptyState onCreate={() => setDialogOpen(true)} />
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {visibleProjects.map((project) => (
                <ProjectRow
                  key={project.projectId}
                  project={project}
                  onDeleteClick={handleDelete}
                />
              ))}
            </div>

            {showPagination ? (
              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                  disabled={currentPage === 0}
                >
                  上一页
                </Button>
                <span className="text-xs text-muted-foreground">
                  第 {currentPage + 1} 页 / 共 {totalPages} 页
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setCurrentPage((p) => Math.min(totalPages - 1, p + 1))
                  }
                  disabled={currentPage >= totalPages - 1}
                >
                  下一页
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <NewProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={handleCreated}
      />
    </main>
  );
}

function ProjectListSkeleton(): React.JSX.Element {
  return (
    <div
      className="flex flex-col gap-2"
      role="status"
      aria-label="加载项目列表"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border bg-background p-3"
        >
          <div className="size-14 shrink-0 animate-pulse rounded-md bg-muted" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  onCreate,
}: {
  onCreate: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-12 text-center">
      <p className="text-sm text-muted-foreground">暂无项目</p>
      <Button size="sm" onClick={onCreate}>
        新建项目
      </Button>
    </div>
  );
}
