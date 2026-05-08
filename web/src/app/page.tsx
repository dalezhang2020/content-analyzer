"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";

interface DashboardData {
  totalAnalyses: number;
  byPlatform: Record<string, number>;
  recentAnalyses: { id: string; title: string; platform: string; analyzedAt: string }[];
  topKeywords: { keyword: string; count: number }[];
  styleDistribution: Record<string, number>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <main className="flex-1 px-6 py-8">
        <p className="text-sm text-muted-foreground">Loading dashboard...</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="flex-1 px-6 py-8">
        <p className="text-sm text-muted-foreground">Failed to load dashboard.</p>
      </main>
    );
  }

  const maxKeywordCount = data.topKeywords[0]?.count || 1;

  return (
    <main className="flex-1 px-6 py-8">
      <div className="w-full max-w-4xl space-y-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Overview of your content research activity.
          </p>
        </header>

        {/* Stats cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Analyses</p>
            <p className="text-3xl font-semibold mt-1">{data.totalAnalyses}</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">小红书</p>
            <p className="text-3xl font-semibold mt-1">{data.byPlatform.xiaohongshu || 0}</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">YouTube</p>
            <p className="text-3xl font-semibold mt-1">{data.byPlatform.youtube || 0}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent analyses */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Recent Analyses</h2>
            {data.recentAnalyses.length === 0 ? (
              <p className="text-sm text-muted-foreground">No analyses yet.</p>
            ) : (
              <div className="space-y-2">
                {data.recentAnalyses.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => router.push(`/history/${item.id}`)}
                    className="w-full text-left flex items-center gap-3 p-2.5 rounded-md border border-border hover:border-amber-600/30 transition-colors"
                  >
                    <span className="flex-1 text-sm truncate">{item.title}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{formatDate(item.analyzedAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Top keywords */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Top Keywords</h2>
            {data.topKeywords.length === 0 ? (
              <p className="text-sm text-muted-foreground">No keyword data yet.</p>
            ) : (
              <div className="space-y-2">
                {data.topKeywords.map((kw) => (
                  <div key={kw.keyword} className="flex items-center gap-3">
                    <span className="text-sm w-20 truncate">{kw.keyword}</span>
                    <div className="flex-1 h-5 bg-muted rounded overflow-hidden">
                      <div
                        className="h-full bg-amber-600/60 rounded"
                        style={{ width: `${(kw.count / maxKeywordCount) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground w-6 text-right">{kw.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Style distribution */}
        {Object.keys(data.styleDistribution).length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Content Style Distribution</h2>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.styleDistribution)
                .sort((a, b) => b[1] - a[1])
                .map(([style, count]) => (
                  <Badge key={style} variant="secondary" className="text-xs">
                    {style} ({count})
                  </Badge>
                ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
