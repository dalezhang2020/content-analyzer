"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { use } from "react";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ResultsView } from "@/components/results-view";
import { AnalysisResult } from "@/lib/types";

interface HistoryEntry {
  id: string;
  url: string;
  platform: "xiaohongshu" | "youtube";
  analyzedAt: string;
  result: AnalysisResult;
}

const platformConfig = {
  xiaohongshu: { label: "小红书", className: "bg-rose-500/10 text-rose-600 border-rose-500/20" },
  youtube: { label: "YouTube", className: "bg-red-500/10 text-red-600 border-red-500/20" },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export default function HistoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [entry, setEntry] = useState<HistoryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchEntry() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/history/${id}`);
        if (res.status === 404) {
          setError("Analysis not found.");
          return;
        }
        if (!res.ok) {
          setError("Failed to load analysis.");
          return;
        }
        const data: HistoryEntry = await res.json();
        setEntry(data);
      } catch {
        setError("Failed to load analysis.");
      } finally {
        setLoading(false);
      }
    }
    fetchEntry();
  }, [id]);

  const handleCreateProject = async () => {
    if (!entry) return;
    const r = entry.result;
    const title = window.prompt(
      "项目标题：",
      r?.metadata?.title?.slice(0, 60) || "基于此分析创建的项目",
    );
    if (!title?.trim()) return;

    // Seed a Brief from the analysis so the project opens at the
    // storyboard stage with the Brief tab already populated.
    // Fall back gracefully when the Python analyzer didn't fill in the
    // deep-content fields (older history entries).
    const corePoints =
      r.key_points && r.key_points.length >= 3
        ? r.key_points.slice(0, 5)
        : r.takeaways && r.takeaways.length >= 3
          ? r.takeaways.slice(0, 5)
          : r.reusable_angles && r.reusable_angles.length >= 3
            ? r.reusable_angles.slice(0, 5)
            : null;

    const topic =
      r.summary?.slice(0, 500) ||
      r.unique_angle?.slice(0, 500) ||
      r.hook?.slice(0, 500) ||
      title.trim();

    const payload: Record<string, unknown> = {
      title: title.trim(),
      topic,
    };

    // Only include seedBrief when we have the minimum required fields.
    if (corePoints && corePoints.length >= 3) {
      payload.seedBrief = {
        title: title.trim().slice(0, 60),
        audience: (r.target_audience || "关注此类内容的创作者").slice(0, 200),
        corePoints: corePoints.map((p) => p.slice(0, 200)),
        tone: (r.content_style || "信息密度高、直接").slice(0, 60),
        targetDurationSec: 45,
        suggestedStyle: (r.content_style || "editorial").slice(0, 200),
      };
    }

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`创建失败：${body?.error?.message || res.status}`);
        return;
      }
      const project = await res.json();
      router.push(`/projects/${project.projectId}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "创建失败");
    }
  };

  return (
    <main className="flex-1 flex flex-col px-6 py-8">
      <div className="w-full max-w-4xl space-y-6">
        {/* Back link */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/history")}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-amber-700 transition-colors"
          >
            <ArrowLeft className="size-4" />
            Back to History
          </button>
          {entry && (
            <button
              onClick={handleCreateProject}
              className="text-xs px-3 py-1.5 rounded-md bg-amber-600 text-white hover:bg-amber-700 transition-colors"
            >
              + 基于此分析创建项目
            </button>
          )}
        </div>

        {/* Loading state */}
        {loading && (
          <div className="text-sm text-muted-foreground py-12 text-center">
            Loading analysis...
          </div>
        )}

        {/* Error / 404 state */}
        {!loading && error && (
          <div className="text-sm text-muted-foreground py-12 text-center">
            {error}
          </div>
        )}

        {/* Entry detail */}
        {!loading && !error && entry && (
          <>
            {/* Metadata header */}
            <div className="space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <Badge
                  variant="outline"
                  className={platformConfig[entry.platform].className}
                >
                  {platformConfig[entry.platform].label}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {formatDate(entry.analyzedAt)}
                </span>
              </div>
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-muted-foreground hover:text-amber-700 transition-colors break-all"
              >
                {entry.url}
              </a>
            </div>

            {/* Full analysis result */}
            <ResultsView result={entry.result} />
          </>
        )}
      </div>
    </main>
  );
}
