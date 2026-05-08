"use client";

import { AnalysisResult } from "@/lib/types";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { VideoProgress } from "@/components/video-progress";
import { VideoPlayer } from "@/components/video-player";

interface ActionPanelProps {
  result: AnalysisResult;
}

interface ContentAngle {
  title: string;
  hook: string;
  format: string;
}

function generateAngles(result: AnalysisResult): ContentAngle[] {
  const angles: ContentAngle[] = [];
  const topics = [
    ...(result.reusable_angles || []),
    ...(result.adaptation_ideas || []),
  ];
  const hooks = result.engagement_hooks || [];
  const keywords = result.keywords || [];

  // Generate angles from reusable_angles and adaptation_ideas
  for (let i = 0; i < Math.min(topics.length, 4); i++) {
    const topic = topics[i];
    const hookText = hooks[i % hooks.length] || result.hook || "Open with a bold claim";
    angles.push({
      title: topic.length > 60 ? topic.slice(0, 57) + "…" : topic,
      hook: hookText,
      format: result.content_style || "educational",
    });
  }

  // If we have keywords but few angles, synthesize one
  if (angles.length < 2 && keywords.length >= 2) {
    angles.push({
      title: `Deep dive: ${keywords.slice(0, 3).join(" + ")}`,
      hook: result.hook || "Start with a surprising stat or question",
      format: result.content_style || "explainer",
    });
  }

  return angles;
}

function generateScript(result: AnalysisResult, angle?: ContentAngle): string {
  const hook = angle?.hook || result.hook || "[Your hook here]";
  const structure = result.structure || [];
  const takeaways = result.takeaways || [];
  const cta = result.cta_signals?.[0] || "Follow for more";

  let script = `HOOK:\n"${hook}"\n\n`;
  script += `BODY:\n`;

  if (structure.length > 0) {
    structure.slice(0, 4).forEach((point, i) => {
      script += `${i + 1}. ${point}\n`;
    });
  } else if (takeaways.length > 0) {
    takeaways.slice(0, 3).forEach((point, i) => {
      script += `${i + 1}. ${point}\n`;
    });
  } else {
    script += `1. [Main point]\n2. [Supporting evidence]\n3. [Practical example]\n`;
  }

  script += `\nCLOSE:\n`;
  script += `Key takeaway: ${takeaways[0] || "[Summarize the value]"}\n`;
  script += `CTA: ${cta}\n`;

  return script;
}

function generateTopicOpportunities(result: AnalysisResult): string[] {
  const opportunities: string[] = [];
  const keywords = result.keywords || [];
  const angles = result.reusable_angles || [];
  const adaptations = result.adaptation_ideas || [];

  // Spin topics from keywords
  if (keywords.length >= 2) {
    opportunities.push(`"${keywords[0]} vs ${keywords[1]}" — comparison format`);
  }
  if (keywords.length >= 1) {
    opportunities.push(`"${keywords[0]} mistakes beginners make" — listicle`);
  }

  // From adaptation ideas
  adaptations.slice(0, 2).forEach((idea) => {
    opportunities.push(idea);
  });

  // From angles
  angles.slice(0, 2).forEach((angle) => {
    if (!opportunities.includes(angle)) {
      opportunities.push(angle);
    }
  });

  return opportunities.slice(0, 5);
}

export function ActionPanel({ result }: ActionPanelProps) {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<"angles" | "script" | "topics" | "video">("angles");
  const [selectedAngleIdx, setSelectedAngleIdx] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const angles = generateAngles(result);
  const topics = generateTopicOpportunities(result);
  const script = generateScript(result, angles[selectedAngleIdx]);

  const handleCreatePlan = async () => {
    setPlanLoading(true);
    setPlanError(null);

    try {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: result.metadata.title || "Untitled Plan",
          sourceAnalyses: [],
          angles,
          script,
          topics,
          notes: "",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create plan");
      }
      router.push(`/plans/${data.id}`);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setPlanLoading(false);
    }
  };

  const VIDEO_TIMEOUT_MS = 120_000; // 120 seconds

  const handleGenerateVideo = async () => {
    setVideoLoading(true);
    setVideoError(null);
    setVideoUrl(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VIDEO_TIMEOUT_MS);

    try {
      const res = await fetch("/api/video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result }),
        signal: controller.signal,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Video generation failed");
      }
      setVideoUrl(data.url);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setVideoError("__TIMEOUT__");
      } else {
        setVideoError(err instanceof Error ? err.message : "Unknown error");
      }
    } finally {
      clearTimeout(timeoutId);
      setVideoLoading(false);
    }
  };

  const sections = [
    { key: "angles" as const, label: "Content Angles" },
    { key: "script" as const, label: "Script Starter" },
    { key: "topics" as const, label: "Topic Ideas" },
    { key: "video" as const, label: "🎬 Video" },
  ];

  return (
    <div className="space-y-4">
      {/* Create Content Plan action */}
      <div className="flex items-center gap-3">
        <Button
          onClick={handleCreatePlan}
          disabled={planLoading}
          variant="outline"
          className="border-amber-600/50 text-amber-700 hover:bg-amber-600/10"
        >
          {planLoading ? "Creating plan…" : "📋 Create Content Plan"}
        </Button>
        {planError && (
          <span className="text-sm text-red-600">{planError}</span>
        )}
      </div>

      {/* Section switcher */}
      <div className="flex gap-4 border-b border-border">
        {sections.map((s) => (
          <button
            key={s.key}
            onClick={() => setActiveSection(s.key)}
            className={`pb-2 text-sm font-medium transition-colors border-b-2 ${
              activeSection === s.key
                ? "border-amber-600 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Angles */}
      {activeSection === "angles" && (
        <div className="space-y-3">
          {angles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Not enough data to generate angles. Try a video with more content signals.
            </p>
          ) : (
            angles.map((angle, i) => (
              <div
                key={i}
                onClick={() => setSelectedAngleIdx(i)}
                className={`p-3 rounded-md border cursor-pointer transition-colors ${
                  selectedAngleIdx === i
                    ? "border-amber-600/50 bg-amber-600/5"
                    : "border-border hover:border-amber-600/30"
                }`}
              >
                <p className="text-sm font-medium">{angle.title}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Hook: &ldquo;{angle.hook}&rdquo;
                </p>
                <p className="text-xs text-muted-foreground">
                  Format: {angle.format}
                </p>
              </div>
            ))
          )}
        </div>
      )}

      {/* Script */}
      {activeSection === "script" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Based on {angles[selectedAngleIdx]?.title || "analysis"} — select an angle to change
          </p>
          <pre className="text-sm font-mono bg-muted p-4 rounded-md whitespace-pre-wrap leading-relaxed">
            {script}
          </pre>
        </div>
      )}

      {/* Topics */}
      {activeSection === "topics" && (
        <div className="space-y-2">
          {topics.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Not enough keyword data to suggest topics.
            </p>
          ) : (
            <ul className="space-y-2">
              {topics.map((topic, i) => (
                <li key={i} className="text-sm flex items-start gap-2">
                  <span className="text-amber-600 font-medium shrink-0">{i + 1}.</span>
                  <span>{topic}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Video */}
      {activeSection === "video" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Generate a short video from this analysis — an original &ldquo;content teardown&rdquo; with hook, insights, and action steps.
            </p>
          </div>

          {!videoUrl && !videoError && (
            <Button
              onClick={handleGenerateVideo}
              disabled={videoLoading}
              className="bg-foreground text-background hover:bg-foreground/90"
            >
              {videoLoading ? "Rendering video…" : "Generate Video"}
            </Button>
          )}

          {videoLoading && (
            <VideoProgress isLoading={videoLoading} />
          )}

          {videoError && (
            <div className="flex items-start gap-3 p-3 rounded-md border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30">
              <span className="text-red-600 shrink-0 mt-0.5">⚠️</span>
              <div className="flex-1 space-y-2">
                <p className="text-sm text-red-700 dark:text-red-400">
                  {videoError === "__TIMEOUT__"
                    ? "Video generation timed out (120s limit). Try again or use a shorter analysis."
                    : videoError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateVideo}
                  className="border-red-300 text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/50"
                >
                  Retry
                </Button>
              </div>
            </div>
          )}

          {videoUrl && (
            <div className="space-y-3">
              <VideoPlayer src={videoUrl} autoPlay={true} />
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerateVideo}
              >
                Regenerate
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
