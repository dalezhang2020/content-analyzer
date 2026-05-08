"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, FileText, Code2, Film } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PlanSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceAnalyses: string[];
  currentStage: "script" | "html" | "video";
  outline?: { length?: number };
  htmlContent?: string;
  videoUrl?: string;
}

interface HistoryEntry {
  id: string;
  url: string;
  platform: string;
  result: { metadata?: { title?: string } };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const stageIcons = { script: FileText, html: Code2, video: Film };

export default function PlansPage() {
  const router = useRouter();
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    fetch("/api/plans")
      .then((r) => r.json())
      .then(setPlans)
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this plan?")) return;
    const res = await fetch(`/api/plans/${id}`, { method: "DELETE" });
    if (res.ok) setPlans((prev) => prev.filter((p) => p.id !== id));
  };

  return (
    <main className="flex-1 px-6 py-8">
      <div className="w-full max-w-4xl space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Content Plans</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Three-stage workflow: Script → HTML → Video
            </p>
          </div>
          <Button onClick={() => setShowCreate(true)} size="sm">
            <Plus className="size-4 mr-1" /> New Plan
          </Button>
        </div>

        {showCreate && <CreatePlanDialog onClose={() => setShowCreate(false)} onCreated={(id) => router.push(`/plans/${id}`)} />}

        {loading ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading...</p>
        ) : plans.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-border rounded-lg">
            <p className="text-sm text-muted-foreground mb-3">No plans yet.</p>
            <p className="text-xs text-muted-foreground">Click &quot;New Plan&quot; to start from an analysis.</p>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {plans.map((plan) => {
              const StageIcon = stageIcons[plan.currentStage] || FileText;
              return (
                <div key={plan.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/50 group">
                  <button
                    onClick={() => router.push(`/plans/${plan.id}`)}
                    className="flex-1 text-left flex items-center gap-3 min-w-0"
                  >
                    <StageIcon className="size-4 text-amber-600 shrink-0" />
                    <span className="flex-1 text-sm font-medium truncate group-hover:text-amber-700 transition-colors">
                      {plan.title}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0 uppercase font-mono">
                      {plan.currentStage}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0 w-20 text-right">
                      {formatDate(plan.updatedAt)}
                    </span>
                  </button>
                  <button
                    onClick={() => handleDelete(plan.id)}
                    className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

// --- Create dialog ---
function CreatePlanDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string>("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then(setHistory);
  }, []);

  const handleCreate = async () => {
    if (!title.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          sourceAnalyses: selectedHistoryId ? [selectedHistoryId] : [],
        }),
      });
      if (res.ok) {
        const plan = await res.json();
        onCreated(plan.id);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background border border-border rounded-lg p-6 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold">New Content Plan</h3>

        <div className="space-y-2">
          <label className="text-xs font-medium">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. AI编程工具推荐视频"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium">Source Analysis (optional)</label>
          <select
            value={selectedHistoryId}
            onChange={(e) => setSelectedHistoryId(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">— None (blank plan) —</option>
            {history.map((h) => (
              <option key={h.id} value={h.id}>
                {h.result?.metadata?.title?.slice(0, 60) || h.url.slice(0, 60)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Selecting an analysis enables auto-generating the script from it.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose} size="sm" variant="outline" disabled={creating}>Cancel</Button>
          <Button onClick={handleCreate} size="sm" disabled={!title.trim() || creating}>
            {creating ? "Creating..." : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}
