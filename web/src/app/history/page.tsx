"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface HistoryEntry {
  id: string;
  url: string;
  platform: "xiaohongshu" | "youtube";
  analyzedAt: string;
  result: {
    metadata?: {
      title?: string;
    };
  };
}

type PlatformFilter = "all" | "xiaohongshu" | "youtube";

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

export default function HistoryPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (platformFilter !== "all") {
        params.set("platform", platformFilter);
      }
      const res = await fetch(`/api/history?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setEntries(data);
      }
    } finally {
      setLoading(false);
    }
  }, [platformFilter]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  async function handleDelete(id: string) {
    const confirmed = window.confirm("Are you sure you want to delete this analysis?");
    if (!confirmed) return;

    setDeletingId(id);
    try {
      const res = await fetch(`/api/history/${id}`, { method: "DELETE" });
      if (res.ok) {
        setEntries((prev) => prev.filter((e) => e.id !== id));
      }
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <main className="flex-1 flex flex-col px-6 py-8">
      <div className="w-full max-w-4xl space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">History</h1>
          <p className="text-sm text-muted-foreground mt-1">
            View and manage your past content analyses.
          </p>
        </div>

        {/* Platform filter */}
        <div className="flex items-center gap-2">
          {(["all", "xiaohongshu", "youtube"] as const).map((value) => {
            const label = value === "all" ? "All" : platformConfig[value].label;
            const active = platformFilter === value;
            return (
              <Button
                key={value}
                variant={active ? "default" : "outline"}
                size="sm"
                onClick={() => setPlatformFilter(value)}
                className={cn(active && "bg-amber-600 hover:bg-amber-700 text-white border-amber-600")}
              >
                {label}
              </Button>
            );
          })}
        </div>

        {/* List */}
        {loading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="text-sm text-muted-foreground py-12 text-center">
            No analyses yet. Go to{" "}
            <button
              onClick={() => router.push("/analyze")}
              className="text-amber-600 hover:underline"
            >
              Analyze
            </button>{" "}
            to get started.
          </div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {entries.map((entry) => {
              const title = entry.result?.metadata?.title || entry.url;
              const config = platformConfig[entry.platform];
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-muted/50 transition-colors group"
                >
                  {/* Clickable area */}
                  <button
                    onClick={() => router.push(`/history/${entry.id}`)}
                    className="flex-1 flex items-center gap-4 text-left min-w-0"
                  >
                    {/* Title */}
                    <span className="flex-1 text-sm font-medium truncate group-hover:text-amber-700 transition-colors">
                      {title}
                    </span>

                    {/* Platform badge */}
                    <Badge
                      variant="outline"
                      className={cn("text-[10px] h-5 px-2 shrink-0", config.className)}
                    >
                      {config.label}
                    </Badge>

                    {/* Date */}
                    <span className="text-xs text-muted-foreground shrink-0 w-[120px] text-right">
                      {formatDate(entry.analyzedAt)}
                    </span>
                  </button>

                  {/* Delete button */}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(entry.id);
                    }}
                    disabled={deletingId === entry.id}
                    className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label={`Delete analysis: ${title}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
