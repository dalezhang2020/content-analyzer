/** Mirrors the Python AnalysisResult schema. */
export interface Metadata {
  video_id: string;
  title: string | null;
  channel: string | null;
  publish_date: string | null;
  duration_seconds: number | null;
  view_count: number | null;
}

export interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

export interface Comment {
  author: string | null;
  text: string;
  likes: number;
}

export interface ImageAnalysis {
  title?: string | null;
  headings?: string[];
  key_claims?: string[];
  stats?: string[];
  cta?: string[];
  visual_framing?: string[];
  raw_text?: string | null;
}

export interface AnalysisResult {
  metadata: Metadata;
  transcript: TranscriptSegment[] | null;
  comments: Comment[] | null;
  image_analysis: ImageAnalysis | null;
  hook: string | null;
  structure: string[] | null;
  takeaways: string[] | null;
  reusable_angles: string[] | null;
  keywords: string[] | null;
  content_style: string | null;
  audience_intent: string | null;
  engagement_hooks: string[] | null;
  cta_signals: string[] | null;
  adaptation_ideas: string[] | null;
  warnings: string[];
}

export type PipelineStep =
  | "input"
  | "fetch"
  | "extract"
  | "analyze"
  | "report"
  | "done";

export const PIPELINE_STEPS: { key: PipelineStep; label: string }[] = [
  { key: "input", label: "Input" },
  { key: "fetch", label: "Fetch" },
  { key: "extract", label: "Extract" },
  { key: "analyze", label: "Analyze" },
  { key: "report", label: "Report" },
  { key: "done", label: "Done" },
];
