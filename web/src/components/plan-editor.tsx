"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Plus, Trash2, CheckCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ContentPlan {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceAnalyses: string[];
  angles: { title: string; hook: string; format: string }[];
  script: string;
  topics: string[];
  notes: string;
}

type SaveStatus = "idle" | "saving" | "saved";

export interface PlanEditorProps {
  plan: ContentPlan;
  onChange: (updated: ContentPlan) => void;
}

const DEBOUNCE_MS = 1500;

export function PlanEditor({ plan, onChange }: PlanEditorProps) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-save: debounced PUT to API
  const autoSave = useCallback(
    async (updated: ContentPlan) => {
      setSaveStatus("saving");
      // Cancel any in-flight request
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(`/api/plans/${updated.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: updated.title,
            angles: updated.angles,
            script: updated.script,
            topics: updated.topics,
            notes: updated.notes,
          }),
          signal: controller.signal,
        });
        if (res.ok) {
          const saved = await res.json();
          onChange(saved);
          setSaveStatus("saved");
        } else {
          setSaveStatus("idle");
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== "AbortError") {
          setSaveStatus("idle");
        }
      }
    },
    [onChange]
  );

  // Schedule debounced save on plan change
  const scheduleAutoSave = useCallback(
    (updated: ContentPlan) => {
      onChange(updated);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => autoSave(updated), DEBOUNCE_MS);
    },
    [autoSave, onChange]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // Reset "saved" indicator after 2s
  useEffect(() => {
    if (saveStatus === "saved") {
      const t = setTimeout(() => setSaveStatus("idle"), 2000);
      return () => clearTimeout(t);
    }
  }, [saveStatus]);

  // --- Handlers ---

  const updateTitle = (title: string) => {
    scheduleAutoSave({ ...plan, title });
  };

  const updateScript = (script: string) => {
    scheduleAutoSave({ ...plan, script });
  };

  const updateTopics = (raw: string) => {
    const topics = raw.split("\n").filter(Boolean);
    scheduleAutoSave({ ...plan, topics });
  };

  const updateNotes = (notes: string) => {
    scheduleAutoSave({ ...plan, notes });
  };

  // Angles management
  const addAngle = () => {
    const angles = [...plan.angles, { title: "", hook: "", format: "" }];
    scheduleAutoSave({ ...plan, angles });
  };

  const removeAngle = (index: number) => {
    const angles = plan.angles.filter((_, i) => i !== index);
    scheduleAutoSave({ ...plan, angles });
  };

  const updateAngle = (index: number, field: "title" | "hook" | "format", value: string) => {
    const angles = plan.angles.map((a, i) =>
      i === index ? { ...a, [field]: value } : a
    );
    scheduleAutoSave({ ...plan, angles });
  };

  return (
    <div className="space-y-6">
      {/* Save status indicator */}
      <div className="flex items-center justify-end h-5">
        {saveStatus === "saving" && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Saving...
          </span>
        )}
        {saveStatus === "saved" && (
          <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
            <CheckCircle className="size-3" /> Saved
          </span>
        )}
      </div>

      {/* Title */}
      <div className="space-y-1">
        <label className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Title
        </label>
        <Input
          value={plan.title}
          onChange={(e) => updateTitle(e.target.value)}
          className="text-xl font-semibold h-12"
          placeholder="Plan title"
        />
      </div>

      {/* Angles */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Angles
          </h3>
          <Button onClick={addAngle} variant="outline" size="sm">
            <Plus className="size-3.5 mr-1" /> Add Angle
          </Button>
        </div>
        {plan.angles.length === 0 && (
          <p className="text-sm text-muted-foreground italic">
            No angles yet. Click &quot;Add Angle&quot; to start.
          </p>
        )}
        {plan.angles.map((angle, i) => (
          <div
            key={i}
            className="rounded-md border border-input p-3 space-y-2 relative group"
          >
            <button
              onClick={() => removeAngle(i)}
              className="absolute top-2 right-2 text-muted-foreground hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={`Remove angle ${i + 1}`}
            >
              <Trash2 className="size-3.5" />
            </button>
            <Input
              value={angle.title}
              onChange={(e) => updateAngle(i, "title", e.target.value)}
              placeholder="Angle title"
              className="text-sm font-medium"
            />
            <Input
              value={angle.hook}
              onChange={(e) => updateAngle(i, "hook", e.target.value)}
              placeholder="Hook suggestion"
              className="text-sm"
            />
            <Input
              value={angle.format}
              onChange={(e) => updateAngle(i, "format", e.target.value)}
              placeholder="Format (e.g., tutorial, listicle, review)"
              className="text-sm"
            />
          </div>
        ))}
      </div>

      {/* Script */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Script Outline
        </h3>
        <textarea
          value={plan.script}
          onChange={(e) => updateScript(e.target.value)}
          rows={10}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring/50 resize-y"
          placeholder={"HOOK:\nGrab attention with...\n\nBODY:\nMain points...\n\nKEY TAKEAWAYS:\n- ...\n\nCTA:\nCall to action..."}
        />
      </div>

      {/* Topics */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Topics
        </h3>
        <textarea
          value={plan.topics.join("\n")}
          onChange={(e) => updateTopics(e.target.value)}
          rows={4}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 resize-y"
          placeholder="One topic per line"
        />
      </div>

      {/* Notes */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Notes
        </h3>
        <textarea
          value={plan.notes}
          onChange={(e) => updateNotes(e.target.value)}
          rows={5}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 resize-y"
          placeholder="Free-form notes..."
        />
      </div>
    </div>
  );
}
