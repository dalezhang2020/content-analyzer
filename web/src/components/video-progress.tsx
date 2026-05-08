"use client";

import { useEffect, useRef, useState } from "react";

interface VideoProgressProps {
  isLoading: boolean;
  onComplete?: () => void;
}

interface ProgressStage {
  label: string;
  startPercent: number;
  endPercent: number;
}

const STAGES: ProgressStage[] = [
  { label: "Generating composition…", startPercent: 0, endPercent: 30 },
  { label: "Rendering video…", startPercent: 30, endPercent: 90 },
  { label: "Finalizing…", startPercent: 90, endPercent: 100 },
];

// Estimated total duration in seconds
const ESTIMATED_DURATION = 30;

function getCurrentStage(percent: number): ProgressStage {
  for (const stage of STAGES) {
    if (percent < stage.endPercent) {
      return stage;
    }
  }
  return STAGES[STAGES.length - 1];
}

export function VideoProgress({ isLoading, onComplete }: VideoProgressProps) {
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [completed, setCompleted] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!isLoading) {
      // When loading finishes, jump to 100%
      if (progress > 0 && !completed) {
        setProgress(100);
        setCompleted(true);
        onComplete?.();
      }
      return;
    }

    // Reset state when loading starts
    setProgress(0);
    setElapsed(0);
    setCompleted(false);
    startTimeRef.current = Date.now();

    intervalRef.current = setInterval(() => {
      const elapsedMs = Date.now() - startTimeRef.current;
      const elapsedSec = Math.floor(elapsedMs / 1000);
      setElapsed(elapsedSec);

      // Calculate simulated progress
      // Use an easing curve that slows down as it approaches 90%
      const ratio = elapsedMs / (ESTIMATED_DURATION * 1000);
      let simulatedProgress: number;

      if (ratio < 1) {
        // Ease-out curve: fast start, slows toward 90%
        simulatedProgress = 90 * (1 - Math.pow(1 - ratio, 2));
      } else {
        // Past estimated time: hold at ~90%, creep very slowly
        const overtime = ratio - 1;
        simulatedProgress = 90 + Math.min(overtime * 2, 5);
      }

      setProgress(Math.min(simulatedProgress, 95));
    }, 200);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isLoading && progress === 0) {
    return null;
  }

  const currentStage = getCurrentStage(progress);
  const remaining = Math.max(0, ESTIMATED_DURATION - elapsed);
  const displayPercent = Math.round(progress);

  return (
    <div className="space-y-2">
      {/* Progress bar */}
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-amber-600 rounded-full transition-all duration-200 ease-out"
          style={{ width: `${displayPercent}%` }}
        />
      </div>

      {/* Stage and percentage */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          {!completed && (
            <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
          )}
          {completed ? "✓ Complete" : currentStage.label}
        </span>
        <span className="font-mono">{displayPercent}%</span>
      </div>

      {/* Time info */}
      {!completed && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{elapsed}s elapsed</span>
          <span>
            {elapsed < ESTIMATED_DURATION
              ? `~${remaining}s remaining`
              : "Almost done…"}
          </span>
        </div>
      )}
    </div>
  );
}
