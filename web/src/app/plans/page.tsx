"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PlanSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceAnalyses: string[];
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function PlansPage() {
  const router = useRouter();
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/plans")
      .then((r) => r.json())
      .then(setPlans)
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    const title = window.prompt("Plan title:");
    if (!title?.trim()) return;

    const res = await fetch("/api/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim() }),
    });
    if (res.ok) {
      const plan = await res.json();
      router.push(`/plans/${plan.id}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this plan?")) return;
    const res = await fetch(`/api/plans/${id}`, { method: "DELETE" });
    if (res.ok) {
      setPlans((prev) => prev.filter((p) => p.id !== id));
    }
  };

  return (
    <main className="flex-1 px-6 py-8">
      <div className="w-full max-w-4xl space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Content Plans</h1>
            <p className="text-sm text-muted-foreground mt-1">Create and manage content plans from your analyses.</p>
          </div>
          <Button onClick={handleCreate} size="sm">
            <Plus className="size-4 mr-1" /> New Plan
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading...</p>
        ) : plans.length === 0 ? (
          <p className="text-sm text-muted-foreground py-12 text-center">
            No plans yet. Create one to start planning content.
          </p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {plans.map((plan) => (
              <div key={plan.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/50 group">
                <button
                  onClick={() => router.push(`/plans/${plan.id}`)}
                  className="flex-1 text-left flex items-center gap-4 min-w-0"
                >
                  <span className="flex-1 text-sm font-medium truncate group-hover:text-amber-700 transition-colors">
                    {plan.title}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
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
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
