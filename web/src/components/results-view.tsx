"use client";

import { AnalysisResult } from "@/lib/types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { ActionPanel } from "@/components/action-panel";

interface ResultsViewProps {
  result: AnalysisResult;
}

function MetadataBlock({ result }: { result: AnalysisResult }) {
  const m = result.metadata;
  return (
    <div className="space-y-1">
      <h2 className="text-xl font-semibold tracking-tight">
        {m.title || m.video_id}
      </h2>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {m.channel && <span>{m.channel}</span>}
        {m.publish_date && <span>{m.publish_date}</span>}
        {m.view_count != null && <span>{m.view_count.toLocaleString()} views</span>}
        {m.duration_seconds != null && (
          <span>
            {Math.floor(m.duration_seconds / 60)}m{" "}
            {m.duration_seconds % 60}s
          </span>
        )}
      </div>
    </div>
  );
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-1 text-sm">
        {items.map((item, i) => (
          <li key={i} className="leading-relaxed">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TeardownTab({ result }: { result: AnalysisResult }) {
  return (
    <div className="space-y-6">
      {/* Summary */}
      {result.summary && (
        <div className="space-y-1 p-3 rounded-md bg-muted/50 border border-border">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Summary
          </h3>
          <p className="text-sm leading-relaxed">{result.summary}</p>
        </div>
      )}

      {result.hook && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Hook
          </h3>
          <p className="text-sm leading-relaxed font-medium">{result.hook}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {result.content_style && (
          <Badge variant="secondary">{result.content_style}</Badge>
        )}
        {result.audience_intent && (
          <Badge variant="secondary">{result.audience_intent}</Badge>
        )}
        {result.target_audience && (
          <Badge variant="outline" className="font-normal">{result.target_audience}</Badge>
        )}
      </div>

      {/* Unique angle */}
      {result.unique_angle && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Unique Angle
          </h3>
          <p className="text-sm leading-relaxed">{result.unique_angle}</p>
        </div>
      )}

      {/* Key Points */}
      {result.key_points && (
        <ListSection title="Key Points" items={result.key_points} />
      )}

      {/* Data Points */}
      {result.data_points && result.data_points.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Data & Evidence
          </h3>
          <div className="flex flex-wrap gap-2">
            {result.data_points.map((dp, i) => (
              <span key={i} className="text-xs px-2 py-1 rounded bg-amber-600/10 text-amber-700 border border-amber-600/20">
                {dp}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Content Breakdown */}
      {result.content_breakdown && result.content_breakdown.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Content Breakdown
          </h3>
          <div className="space-y-3">
            {result.content_breakdown.map((section, i) => (
              <div key={i} className="pl-3 border-l-2 border-amber-600/30">
                <p className="text-sm font-medium">{section.section}</p>
                <ul className="mt-1 space-y-0.5">
                  {section.points.map((pt, j) => (
                    <li key={j} className="text-xs text-muted-foreground">{pt}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.structure && (
        <ListSection title="Structure" items={result.structure} />
      )}
      {result.keywords && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Keywords
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {result.keywords.map((kw, i) => (
              <Badge key={i} variant="outline" className="font-normal">
                {kw}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {result.engagement_hooks && (
        <ListSection title="Engagement Hooks" items={result.engagement_hooks} />
      )}
      {result.cta_signals && (
        <ListSection title="CTA Signals" items={result.cta_signals} />
      )}
      {result.takeaways && (
        <ListSection title="Key Takeaways" items={result.takeaways} />
      )}
      {result.reusable_angles && (
        <ListSection title="Reusable Angles" items={result.reusable_angles} />
      )}
      {result.adaptation_ideas && (
        <ListSection title="Adaptation Ideas" items={result.adaptation_ideas} />
      )}
    </div>
  );
}

function ImageTab({ result }: { result: AnalysisResult }) {
  const img = result.image_analysis;
  if (!img) {
    return (
      <p className="text-sm text-muted-foreground">
        No image analysis data for this content.
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {img.title && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Title
          </h3>
          <p className="text-sm">{img.title}</p>
        </div>
      )}
      {img.headings && <ListSection title="Headings" items={img.headings} />}
      {img.key_claims && (
        <ListSection title="Key Claims" items={img.key_claims} />
      )}
      {img.stats && <ListSection title="Stats" items={img.stats} />}
      {img.cta && <ListSection title="CTA" items={img.cta} />}
      {img.visual_framing && (
        <ListSection title="Visual Framing" items={img.visual_framing} />
      )}
      {img.raw_text && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Raw Text
          </h3>
          <pre className="text-xs font-mono bg-muted p-3 rounded-md overflow-x-auto whitespace-pre-wrap">
            {img.raw_text}
          </pre>
        </div>
      )}
    </div>
  );
}

function JsonTab({ result }: { result: AnalysisResult }) {
  return (
    <pre className="text-xs font-mono bg-muted p-4 rounded-md overflow-x-auto whitespace-pre-wrap max-h-[600px] overflow-y-auto">
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}

export function ResultsView({ result }: ResultsViewProps) {
  return (
    <div className="space-y-6">
      <MetadataBlock result={result} />

      {result.warnings.length > 0 && (
        <div className="space-y-1">
          {result.warnings.map((w, i) => (
            <p key={i} className="text-sm text-amber-700">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}

      <Separator />

      <Tabs defaultValue="teardown">
        <TabsList className="bg-transparent border-b rounded-none w-full justify-start gap-4 px-0">
          <TabsTrigger
            value="teardown"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-amber-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2"
          >
            Teardown
          </TabsTrigger>
          <TabsTrigger
            value="actions"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-amber-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2"
          >
            Actions
          </TabsTrigger>
          <TabsTrigger
            value="images"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-amber-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2"
          >
            Images
          </TabsTrigger>
          <TabsTrigger
            value="json"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-amber-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2"
          >
            JSON
          </TabsTrigger>
        </TabsList>
        <TabsContent value="teardown" className="pt-4">
          <TeardownTab result={result} />
        </TabsContent>
        <TabsContent value="actions" className="pt-4">
          <ActionPanel result={result} />
        </TabsContent>
        <TabsContent value="images" className="pt-4">
          <ImageTab result={result} />
        </TabsContent>
        <TabsContent value="json" className="pt-4">
          <JsonTab result={result} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
