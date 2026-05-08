import { NextRequest, NextResponse } from "next/server";
import { listPlans, createPlan, type SceneOutline } from "@/lib/plans";

export async function GET() {
  const plans = await listPlans();
  return NextResponse.json(plans);
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { title, sourceAnalyses, angle, outline, script, topics, notes } = body as {
    title?: string;
    sourceAnalyses?: string[];
    angle?: string;
    outline?: SceneOutline[];
    script?: string;
    topics?: string[];
    notes?: string;
  };

  if (!title || typeof title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const plan = await createPlan({
    title: title.trim(),
    sourceAnalyses: sourceAnalyses || [],
    angle: angle || "",
    outline: outline || [],
    script: script || "",
    topics: topics || [],
    notes: notes || "",
    currentStage: "script",
  });

  return NextResponse.json(plan, { status: 201 });
}
