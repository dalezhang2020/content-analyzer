"use client";

import { useState, useCallback, useRef, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PipelineView } from "@/components/pipeline-view";
import { ResultsView } from "@/components/results-view";
import { BatchInput } from "@/components/batch-input";
import { AnalysisResult, PipelineStep, PIPELINE_STEPS } from "@/lib/types";

export type StepTimings = Record<string, { start: number; end?: number }>;

interface BatchStatus {
  url: string;
  status: "processing" | "done" | "error";
  stage?: string;
  error?: string;
}

function AnalyzeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [url, setUrl] = useState("");
  const [step, setStep] = useState<PipelineStep | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stepTimings, setStepTimings] = useState<StepTimings>({});
  const lastStepRef = useRef<PipelineStep | null>(null);
  const autoTriggeredRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Batch state
  const [batchStatuses, setBatchStatuses] = useState<BatchStatus[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchSummary, setBatchSummary] = useState<{ total: number; success: number; failed: number } | null>(null);

  const handleStepChange = useCallback((newStep: PipelineStep) => {
    const now = Date.now();
    setStepTimings((prev) => {
      const updated = { ...prev };
      // Close the previous step
      const prevStep = lastStepRef.current;
      if (prevStep && updated[prevStep] && !updated[prevStep].end) {
        updated[prevStep] = { ...updated[prevStep], end: now };
      }
      // Open the new step
      updated[newStep] = { start: now };
      return updated;
    });
    lastStepRef.current = newStep;
    setStep(newStep);
  }, []);

  const handleAnalyze = useCallback(async () => {
    if (!url.trim()) return;
    setError(null);
    setResult(null);
    setLoading(true);
    setStepTimings({});
    lastStepRef.current = null;
    handleStepChange("input");

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }

      // Read streaming NDJSON response
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.stage) {
              handleStepChange(msg.stage as PipelineStep);
            }
            if (msg.result) {
              setResult(msg.result as AnalysisResult);
              // Auto-save to history (fire-and-forget)
              fetch("/api/history", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: url.trim(), result: msg.result }),
              }).catch(() => {}); // Silently ignore save failures
            }
            if (msg.error) {
              throw new Error(msg.error);
            }
          } catch (e) {
            if (e instanceof Error && e.message !== line) throw e;
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        const msg = JSON.parse(buffer);
        if (msg.stage) handleStepChange(msg.stage as PipelineStep);
        if (msg.result) {
          setResult(msg.result as AnalysisResult);
          // Auto-save to history (fire-and-forget)
          fetch("/api/history", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: url.trim(), result: msg.result }),
          }).catch(() => {}); // Silently ignore save failures
        }
        if (msg.error) throw new Error(msg.error);
      }
    } catch (err: unknown) {
      setStep(null);
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
      // Close the last step timing
      setStepTimings((prev) => {
        const last = lastStepRef.current;
        if (last && prev[last] && !prev[last].end) {
          return { ...prev, [last]: { ...prev[last], end: Date.now() } };
        }
        return prev;
      });
    }
  }, [url, handleStepChange]);

  // Auto-fill and auto-trigger from ?url= query param
  useEffect(() => {
    const urlParam = searchParams.get("url");
    if (urlParam && !autoTriggeredRef.current) {
      autoTriggeredRef.current = true;
      setUrl(urlParam);
    }
  }, [searchParams]);

  // Trigger analysis once URL is set from query param
  useEffect(() => {
    if (autoTriggeredRef.current && url && !loading && !result && !error) {
      const timer = setTimeout(() => {
        handleAnalyze();
      }, 100);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Debounced sync of draft URL to query params for state preservation
  useEffect(() => {
    // Skip syncing if this was auto-triggered from a query param (avoid loop)
    if (autoTriggeredRef.current) return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      const currentParam = searchParams.get("url") || "";
      if (url.trim() !== currentParam) {
        const params = new URLSearchParams();
        if (url.trim()) params.set("url", url.trim());
        const paramString = params.toString();
        const newUrl = paramString ? `/analyze?${paramString}` : "/analyze";
        router.replace(newUrl, { scroll: false });
      }
    }, 500);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [url, router, searchParams]);

  // Batch handler
  const handleBatch = useCallback(async (urls: string[]) => {
    setBatchRunning(true);
    setBatchStatuses(urls.map((u) => ({ url: u, status: "processing" as const, stage: "queued" })));
    setBatchSummary(null);

    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Batch failed (${res.status})`);
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.url && msg.status) {
              setBatchStatuses((prev) =>
                prev.map((s) =>
                  s.url === msg.url
                    ? { ...s, status: msg.status, stage: msg.stage, error: msg.error }
                    : s
                )
              );
            }
            if (msg.summary) {
              setBatchSummary(msg.summary);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch (err) {
      setBatchSummary({ total: urls.length, success: 0, failed: urls.length });
    } finally {
      setBatchRunning(false);
    }
  }, []);

  return (
    <main className="flex-1 flex flex-col items-center px-4 py-12 sm:py-20">
      <div className="w-full max-w-2xl space-y-8">
        {/* Header */}
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Content Analyzer
          </h1>
          <p className="text-sm text-muted-foreground">
            Analyze YouTube or Xiaohongshu content.
          </p>
        </header>

        {/* Mode tabs */}
        <div className="flex gap-4 border-b border-border">
          <button
            onClick={() => setMode("single")}
            className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
              mode === "single"
                ? "border-amber-600 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Single URL
          </button>
          <button
            onClick={() => setMode("batch")}
            className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
              mode === "batch"
                ? "border-amber-600 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Batch
          </button>
        </div>

        {/* Single mode */}
        {mode === "single" && (
          <>
            <div className="flex gap-2">
              <Input
                type="url"
                placeholder="https://www.youtube.com/watch?v=... or https://www.xiaohongshu.com/explore/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !loading) handleAnalyze();
                }}
                className="flex-1 h-11 text-sm"
                disabled={loading}
              />
              <Button
                onClick={handleAnalyze}
                disabled={loading || !url.trim()}
                className="h-11 px-5 bg-foreground text-background hover:bg-foreground/90"
              >
                {loading ? "Analyzing…" : "Analyze"}
              </Button>
            </div>

            {step && <PipelineView currentStep={step} stepTimings={stepTimings} />}

            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
                {error}
              </div>
            )}

            {result && <ResultsView result={result} />}
          </>
        )}

        {/* Batch mode */}
        {mode === "batch" && (
          <>
            <BatchInput
              onSubmit={handleBatch}
              disabled={batchRunning}
            />

            {/* Batch progress */}
            {batchStatuses.length > 0 && (
              <div className="space-y-2">
                {batchStatuses.map((s, i) => (
                  <div key={i} className="flex items-center gap-3 text-sm py-1.5 px-3 rounded border border-border">
                    <span className={`size-2 rounded-full shrink-0 ${
                      s.status === "done" ? "bg-emerald-500" :
                      s.status === "error" ? "bg-red-500" :
                      "bg-amber-500 animate-pulse"
                    }`} />
                    <span className="flex-1 truncate text-xs">{s.url}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {s.status === "done" ? "✓" : s.status === "error" ? s.error?.slice(0, 30) : s.stage || "..."}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Batch summary */}
            {batchSummary && (
              <div className="text-sm p-3 rounded border border-border bg-muted/50">
                Done: {batchSummary.success} succeeded, {batchSummary.failed} failed ({batchSummary.total} total)
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

export default function AnalyzePage() {
  return (
    <Suspense>
      <AnalyzeContent />
    </Suspense>
  );
}
