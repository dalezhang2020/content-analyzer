"use client";

import { useState, useCallback, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PipelineView } from "@/components/pipeline-view";
import { ResultsView } from "@/components/results-view";
import { AnalysisResult, PipelineStep, PIPELINE_STEPS } from "@/lib/types";

export type StepTimings = Record<string, { start: number; end?: number }>;

export default function Home() {
  const [url, setUrl] = useState("");
  const [step, setStep] = useState<PipelineStep | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stepTimings, setStepTimings] = useState<StepTimings>({});
  const lastStepRef = useRef<PipelineStep | null>(null);

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
        if (msg.result) setResult(msg.result as AnalysisResult);
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

  return (
    <main className="flex-1 flex flex-col items-center px-4 py-12 sm:py-20">
      <div className="w-full max-w-2xl space-y-8">
        {/* Header */}
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Content Analyzer
          </h1>
          <p className="text-sm text-muted-foreground">
            Paste a YouTube or Xiaohongshu URL to analyze.
          </p>
        </header>

        {/* Input */}
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

        {/* Pipeline */}
        {step && <PipelineView currentStep={step} stepTimings={stepTimings} />}

        {/* Error */}
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
            {error}
          </div>
        )}

        {/* Results */}
        {result && <ResultsView result={result} />}
      </div>
    </main>
  );
}
