"use client";

import { AnalysisResult } from "@/lib/types";
import { useState } from "react";

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
  const [activeSection, setActiveSection] = useState<"angles" | "script" | "topics">("angles");
  const [selectedAngleIdx, setSelectedAngleIdx] = useState(0);

  const angles = generateAngles(result);
  const topics = generateTopicOpportunities(result);
  const script = generateScript(result, angles[selectedAngleIdx]);

  const sections = [
    { key: "angles" as const, label: "Content Angles" },
    { key: "script" as const, label: "Script Starter" },
    { key: "topics" as const, label: "Topic Ideas" },
  ];

  return (
    <div className="space-y-4">
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
    </div>
  );
}
