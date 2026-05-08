"use client";

import { useEffect, useState, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Save, Wand2, Play, Film, FileText, Code2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SceneOutline {
  id: string;
  title: string;
  type: "hook" | "content" | "data" | "action" | "closing";
  duration: number;
  content: string;
  notes?: string;
}

interface ContentPlan {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceAnalyses: string[];
  angle: string;
  outline: SceneOutline[];
  script: string;
  htmlStyle?: string;
  htmlContent?: string;
  htmlUpdatedAt?: string;
  videoEngine?: "hyperframes" | "remotion";
  videoUrl?: string;
  videoRenderedAt?: string;
  topics: string[];
  notes: string;
  currentStage: "script" | "html" | "video";
}

type Stage = "script" | "html" | "video";

const SCENE_TYPE_COLORS: Record<string, string> = {
  hook: "border-amber-500/50 bg-amber-500/5",
  content: "border-blue-500/50 bg-blue-500/5",
  data: "border-emerald-500/50 bg-emerald-500/5",
  action: "border-purple-500/50 bg-purple-500/5",
  closing: "border-rose-500/50 bg-rose-500/5",
};

export default function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [plan, setPlan] = useState<ContentPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<Stage>("script");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/plans/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then((p: ContentPlan) => {
        setPlan(p);
        setActiveStage(p.currentStage || "script");
      })
      .catch(() => setError("Plan not found"))
      .finally(() => setLoading(false));
  }, [id]);

  const savePlan = useCallback(async (updates: Partial<ContentPlan>) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/plans/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) setPlan(await res.json());
    } finally {
      setSaving(false);
    }
  }, [id]);

  const handleGenerateScript = async () => {
    if (!plan || plan.sourceAnalyses.length === 0) {
      alert("This plan has no source analysis. Create a plan from a history entry.");
      return;
    }
    setBusy("Generating script from analysis...");
    try {
      const res = await fetch("/api/plans/generate-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceAnalysisId: plan.sourceAnalyses[0], angle: plan.angle }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      await savePlan({
        angle: data.angle,
        outline: data.outline,
        script: data.script,
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Script generation failed");
    } finally {
      setBusy(null);
    }
  };

  const handleGenerateHtml = async () => {
    if (!plan) return;
    if (plan.outline.length === 0) {
      alert("Fill in the script outline first.");
      return;
    }
    setBusy("Generating HTML with kiro-cli + claude-opus-4.7 + claude-design skill (~1-3 min)...");
    try {
      const res = await fetch("/api/plans/generate-html", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setPlan(data.plan);
      setActiveStage("html");
    } catch (err) {
      alert(err instanceof Error ? err.message : "HTML generation failed");
    } finally {
      setBusy(null);
    }
  };

  const handleRenderVideo = async () => {
    if (!plan?.htmlContent) {
      alert("Generate HTML first.");
      return;
    }
    setBusy("Rendering video (~15s)...");
    try {
      const res = await fetch("/api/plans/render-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setPlan(data.plan);
      setActiveStage("video");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Render failed");
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <main className="flex-1 px-6 py-8"><p className="text-sm text-muted-foreground">Loading...</p></main>;
  if (error || !plan) return <main className="flex-1 px-6 py-8"><p className="text-sm text-muted-foreground">{error || "Not found"}</p></main>;

  const stages: { key: Stage; label: string; icon: typeof FileText; available: boolean }[] = [
    { key: "script", label: "Script", icon: FileText, available: true },
    { key: "html", label: "HTML", icon: Code2, available: plan.outline.length > 0 },
    { key: "video", label: "Video", icon: Film, available: !!plan.htmlContent },
  ];

  return (
    <main className="flex-1 px-6 py-8">
      <div className="w-full max-w-5xl space-y-6">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/plans")}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-amber-700 transition-colors"
          >
            <ArrowLeft className="size-4" /> Back to Plans
          </button>
          <div className="flex items-center gap-2">
            {saving && <span className="text-xs text-muted-foreground">Saving…</span>}
            <Button onClick={() => savePlan({ title: plan.title, angle: plan.angle, script: plan.script, outline: plan.outline, topics: plan.topics, notes: plan.notes })} disabled={saving} size="sm" variant="outline">
              <Save className="size-3.5 mr-1" /> Save
            </Button>
          </div>
        </div>

        {/* Title */}
        <Input
          value={plan.title}
          onChange={(e) => setPlan({ ...plan, title: e.target.value })}
          className="text-xl font-semibold h-12"
        />

        {/* Stage progress */}
        <div className="flex items-center gap-1 border-b border-border">
          {stages.map((s, i) => (
            <button
              key={s.key}
              onClick={() => s.available && setActiveStage(s.key)}
              disabled={!s.available}
              className={cn(
                "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2",
                activeStage === s.key ? "border-amber-600 text-foreground"
                  : s.available ? "border-transparent text-muted-foreground hover:text-foreground"
                  : "border-transparent text-muted-foreground/40 cursor-not-allowed"
              )}
            >
              <s.icon className="size-3.5" />
              <span className="text-xs font-mono">{i + 1}.</span> {s.label}
            </button>
          ))}
        </div>

        {/* Busy indicator */}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3">
            <Loader2 className="size-4 animate-spin" />
            {busy}
          </div>
        )}

        {/* Stage content */}
        {activeStage === "script" && (
          <ScriptStage plan={plan} setPlan={setPlan} onGenerate={handleGenerateScript} onNext={handleGenerateHtml} busy={!!busy} />
        )}

        {activeStage === "html" && (
          <HtmlStage plan={plan} onGenerate={handleGenerateHtml} onNext={handleRenderVideo} busy={!!busy} />
        )}

        {activeStage === "video" && (
          <VideoStage plan={plan} onRender={handleRenderVideo} busy={!!busy} />
        )}
      </div>
    </main>
  );
}

// --- Stage 1: Script ---
function ScriptStage({
  plan, setPlan, onGenerate, onNext, busy,
}: {
  plan: ContentPlan;
  setPlan: (p: ContentPlan) => void;
  onGenerate: () => void;
  onNext: () => void;
  busy: boolean;
}) {
  const updateScene = (idx: number, updates: Partial<SceneOutline>) => {
    const newOutline = [...plan.outline];
    newOutline[idx] = { ...newOutline[idx], ...updates };
    setPlan({ ...plan, outline: newOutline });
  };

  const addScene = () => {
    setPlan({
      ...plan,
      outline: [...plan.outline, {
        id: `s${Date.now()}`, title: "New scene", type: "content", duration: 4, content: "",
      }],
    });
  };

  const removeScene = (idx: number) => {
    setPlan({ ...plan, outline: plan.outline.filter((_, i) => i !== idx) });
  };

  return (
    <div className="space-y-6">
      {/* Generate button if empty */}
      {plan.outline.length === 0 && (
        <div className="text-center py-8 border border-dashed border-border rounded-lg">
          <p className="text-sm text-muted-foreground mb-3">No script yet.</p>
          <Button onClick={onGenerate} disabled={busy}>
            <Wand2 className="size-4 mr-1" /> Generate from analysis
          </Button>
        </div>
      )}

      {/* Angle */}
      <div className="space-y-2">
        <label className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">切入点 / Angle</label>
        <textarea
          value={plan.angle}
          onChange={(e) => setPlan({ ...plan, angle: e.target.value })}
          placeholder="一句话说明视频的核心观点、差异化切入点"
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
        />
      </div>

      {/* Outline */}
      {plan.outline.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">场景大纲 / Outline</label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Total: {plan.outline.reduce((s, o) => s + (o.duration || 0), 0)}s
              </span>
              <Button onClick={onGenerate} disabled={busy} size="sm" variant="outline">
                <Wand2 className="size-3.5 mr-1" /> Regenerate
              </Button>
            </div>
          </div>

          {plan.outline.map((scene, idx) => (
            <div key={scene.id} className={cn("rounded-lg border p-3 space-y-2", SCENE_TYPE_COLORS[scene.type])}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-muted-foreground">{idx + 1}.</span>
                <select
                  value={scene.type}
                  onChange={(e) => updateScene(idx, { type: e.target.value as SceneOutline["type"] })}
                  className="text-xs border border-input rounded px-2 py-1 bg-background"
                >
                  <option value="hook">Hook</option>
                  <option value="content">Content</option>
                  <option value="data">Data</option>
                  <option value="action">Action</option>
                  <option value="closing">Closing</option>
                </select>
                <Input
                  value={scene.title}
                  onChange={(e) => updateScene(idx, { title: e.target.value })}
                  placeholder="Scene title"
                  className="flex-1 h-7 text-sm"
                />
                <Input
                  type="number"
                  value={scene.duration}
                  onChange={(e) => updateScene(idx, { duration: Number(e.target.value) })}
                  className="w-16 h-7 text-sm"
                />
                <span className="text-xs text-muted-foreground">s</span>
                <button
                  onClick={() => removeScene(idx)}
                  className="text-xs text-muted-foreground hover:text-destructive px-1"
                >
                  ✕
                </button>
              </div>
              <textarea
                value={scene.content}
                onChange={(e) => updateScene(idx, { content: e.target.value })}
                placeholder="Scene content..."
                rows={3}
                className="w-full text-sm bg-transparent border-0 focus:outline-none resize-none"
              />
            </div>
          ))}

          <button
            onClick={addScene}
            className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border border-dashed border-border rounded-lg"
          >
            + Add scene
          </button>
        </div>
      )}

      {/* Full script */}
      <div className="space-y-2">
        <label className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">完整文案 / Full Script</label>
        <textarea
          value={plan.script}
          onChange={(e) => setPlan({ ...plan, script: e.target.value })}
          placeholder="Full narration script (voiceover text)..."
          rows={8}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring/50"
        />
      </div>

      {/* Next button */}
      {plan.outline.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={onNext} disabled={busy} className="bg-foreground text-background hover:bg-foreground/90">
            Generate HTML <Play className="size-3.5 ml-1" />
          </Button>
        </div>
      )}
    </div>
  );
}

// --- Stage 2: HTML ---
function HtmlStage({
  plan, onGenerate, onNext, busy,
}: {
  plan: ContentPlan;
  onGenerate: () => void;
  onNext: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      {plan.htmlContent ? (
        <>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">HTML Composition Ready</p>
              <p className="text-xs text-muted-foreground">
                {plan.htmlStyle && `${plan.htmlStyle} · `}
                Generated {plan.htmlUpdatedAt ? new Date(plan.htmlUpdatedAt).toLocaleString() : "just now"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={onGenerate} disabled={busy} size="sm" variant="outline">
                <Wand2 className="size-3.5 mr-1" /> Regenerate
              </Button>
              <Button onClick={onNext} disabled={busy} size="sm">
                Render Video <Film className="size-3.5 ml-1" />
              </Button>
            </div>
          </div>

          {/* Preview iframe */}
          <div className="border border-border rounded-lg overflow-hidden bg-black" style={{ aspectRatio: "16/9" }}>
            <iframe
              srcDoc={plan.htmlContent}
              className="w-full h-full"
              title="HTML Preview"
            />
          </div>

          {/* Source */}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Preview HTML source ({(plan.htmlContent.length / 1024).toFixed(1)}KB)
            </summary>
            <pre className="mt-2 font-mono bg-muted p-3 rounded-md overflow-x-auto max-h-[400px] overflow-y-auto whitespace-pre-wrap">
              {plan.htmlContent}
            </pre>
          </details>
        </>
      ) : (
        <div className="text-center py-12 border border-dashed border-border rounded-lg space-y-3">
          <p className="text-sm text-muted-foreground">
            Generate HTML using <code className="px-1.5 py-0.5 rounded bg-muted text-xs">kiro-cli</code> + <code className="px-1.5 py-0.5 rounded bg-muted text-xs">claude-opus-4.7</code> with the claude-design skill
          </p>
          <p className="text-xs text-muted-foreground">~1-3 minutes per generation</p>
          <Button onClick={onGenerate} disabled={busy} className="bg-amber-600 hover:bg-amber-700">
            <Wand2 className="size-4 mr-1" /> Generate HTML
          </Button>
        </div>
      )}
    </div>
  );
}

// --- Stage 3: Video ---
function VideoStage({
  plan, onRender, busy,
}: {
  plan: ContentPlan;
  onRender: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      {plan.videoUrl ? (
        <>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Video Rendered</p>
              <p className="text-xs text-muted-foreground">
                {plan.videoRenderedAt ? new Date(plan.videoRenderedAt).toLocaleString() : ""}
                {plan.videoEngine && ` · ${plan.videoEngine}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <a href={plan.videoUrl} download className="text-sm text-muted-foreground hover:text-foreground underline">
                Download MP4
              </a>
              <Button onClick={onRender} disabled={busy} size="sm" variant="outline">
                Re-render
              </Button>
            </div>
          </div>
          <video
            src={plan.videoUrl}
            controls
            autoPlay
            className="w-full rounded-lg border border-border bg-black"
            style={{ aspectRatio: "16/9" }}
          />
        </>
      ) : (
        <div className="text-center py-12 border border-dashed border-border rounded-lg">
          <p className="text-sm text-muted-foreground mb-3">No video rendered yet.</p>
          <Button onClick={onRender} disabled={busy}>
            <Film className="size-4 mr-1" /> Render Video
          </Button>
        </div>
      )}
    </div>
  );
}
