"use client";

import { useEffect, useState, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PlanEditor, type ContentPlan } from "@/components/plan-editor";

export default function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [plan, setPlan] = useState<ContentPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/plans/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then(setPlan)
      .catch(() => setError("Plan not found"))
      .finally(() => setLoading(false));
  }, [id]);

  const handleChange = useCallback((updated: ContentPlan) => {
    setPlan(updated);
  }, []);

  if (loading) {
    return (
      <main className="flex-1 px-6 py-8">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </main>
    );
  }

  if (error || !plan) {
    return (
      <main className="flex-1 px-6 py-8">
        <p className="text-sm text-muted-foreground">{error || "Not found"}</p>
      </main>
    );
  }

  return (
    <main className="flex-1 px-6 py-8">
      <div className="w-full max-w-4xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/plans")}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-amber-700 transition-colors"
          >
            <ArrowLeft className="size-4" /> Back to Plans
          </button>
        </div>

        {/* Plan Editor */}
        <PlanEditor plan={plan} onChange={handleChange} />
      </div>
    </main>
  );
}
