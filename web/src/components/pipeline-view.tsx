"use client";

import { useEffect, useState } from "react";
import { PIPELINE_STEPS, PipelineStep } from "@/lib/types";
import { cn } from "@/lib/utils";

type StepTimings = Record<string, { start: number; end?: number }>;

interface PipelineViewProps {
  currentStep: PipelineStep | null;
  stepTimings: StepTimings;
}

// Descriptive messages for each pipeline stage
const STEP_DESCRIPTIONS: Record<PipelineStep, string> = {
  input: "Validating URL and detecting platform…",
  fetch: "Fetching page content and metadata…",
  extract: "Extracting text, images, and structured data…",
  analyze: "Running content analysis and pattern detection…",
  report: "Generating teardown report…",
  done: "Analysis complete",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Live elapsed timer for the active step
function ElapsedTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(Date.now() - startTime);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 100);
    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <span className="text-stone-400 tabular-nums">{formatDuration(elapsed)}</span>
  );
}

export function PipelineView({ currentStep, stepTimings }: PipelineViewProps) {
  const currentIdx = currentStep
    ? PIPELINE_STEPS.findIndex((s) => s.key === currentStep)
    : -1;

  return (
    <div className="space-y-4">
      {/* Step dots */}
      <div className="flex items-center justify-center gap-0">
        {PIPELINE_STEPS.map((step, idx) => {
          const isActive = idx === currentIdx;
          const isDone = idx < currentIdx;
          return (
            <div key={step.key} className="flex items-center">
              {idx > 0 && (
                <div
                  className={cn(
                    "h-px w-8 sm:w-12 transition-colors duration-300",
                    isDone ? "bg-amber-600" : "bg-border"
                  )}
                />
              )}
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className={cn(
                    "w-3 h-3 rounded-full border-2 transition-all duration-300",
                    isDone && "bg-amber-600 border-amber-600",
                    isActive &&
                      "border-amber-600 bg-amber-600/20 animate-pulse",
                    !isDone && !isActive && "border-border bg-background"
                  )}
                />
                <span
                  className={cn(
                    "text-xs font-medium transition-colors duration-300",
                    isDone && "text-foreground",
                    isActive && "text-amber-600",
                    !isDone && !isActive && "text-muted-foreground"
                  )}
                >
                  {step.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Thinking chain log */}
      {currentStep && currentStep !== "done" && (
        <div className="bg-stone-50 border border-stone-200 rounded-md p-3 space-y-1.5">
          {PIPELINE_STEPS.slice(0, currentIdx + 1).map((step, idx) => {
            const isActive = idx === currentIdx;
            const isDone = idx < currentIdx;
            const timing = stepTimings[step.key];
            const duration = timing?.end
              ? timing.end - timing.start
              : undefined;

            return (
              <div
                key={step.key}
                className={cn(
                  "flex items-center gap-2 text-xs transition-opacity duration-300",
                  isActive && "text-amber-700 font-medium",
                  isDone && "text-stone-500"
                )}
              >
                <span className="w-4 text-center flex-shrink-0">
                  {isDone ? "✓" : "●"}
                </span>
                <span className="flex-1">
                  {isDone
                    ? STEP_DESCRIPTIONS[step.key].replace("…", "")
                    : STEP_DESCRIPTIONS[step.key]}
                </span>
                {/* Timing display */}
                {isDone && duration !== undefined && (
                  <span className="text-stone-400 tabular-nums flex-shrink-0">
                    {formatDuration(duration)}
                  </span>
                )}
                {isActive && timing && (
                  <span className="flex-shrink-0 text-xs">
                    <ElapsedTimer startTime={timing.start} />
                  </span>
                )}
                {isActive && (
                  <span className="inline-block w-1 h-1 rounded-full bg-amber-600 animate-pulse" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Done state */}
      {currentStep === "done" && (
        <div className="bg-stone-50 border border-stone-200 rounded-md p-3 space-y-1.5">
          {PIPELINE_STEPS.map((step) => {
            const timing = stepTimings[step.key];
            const duration = timing?.end
              ? timing.end - timing.start
              : undefined;

            return (
              <div
                key={step.key}
                className="flex items-center gap-2 text-xs text-stone-500"
              >
                <span className="w-4 text-center flex-shrink-0 text-emerald-600">
                  ✓
                </span>
                <span className="flex-1">
                  {STEP_DESCRIPTIONS[step.key].replace("…", "")}
                </span>
                {duration !== undefined && (
                  <span className="text-stone-400 tabular-nums flex-shrink-0">
                    {formatDuration(duration)}
                  </span>
                )}
              </div>
            );
          })}
          {/* Total time */}
          {stepTimings["input"]?.start && stepTimings["done"]?.end && (
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 pt-1 border-t border-stone-200 mt-1.5">
              <span className="w-4" />
              <span className="flex-1">Total</span>
              <span className="tabular-nums">
                {formatDuration(
                  stepTimings["done"].end - stepTimings["input"].start
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
