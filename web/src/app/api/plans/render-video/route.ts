import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { getPlan, updatePlan } from "@/lib/plans";

/**
 * POST /api/plans/render-video
 * Body: { planId: string }
 *
 * Renders the plan's stored HTML to MP4 using HyperFrames.
 */
export async function POST(request: NextRequest) {
  let body: { planId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { planId } = body;
  if (!planId) return NextResponse.json({ error: "planId required" }, { status: 400 });

  const plan = await getPlan(planId);
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  if (!plan.htmlContent) return NextResponse.json({ error: "No HTML content. Generate HTML first." }, { status: 400 });

  // Write HTML to temp dir
  const tmpDir = path.join(os.tmpdir(), `ca-plan-video-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "index.html"), plan.htmlContent, "utf-8");

  // Output to web/public/videos/
  const videosDir = path.join(process.cwd(), "public", "videos");
  if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

  const filename = `plan-${planId}-${Date.now()}.mp4`;
  const outputPath = path.join(videosDir, filename);

  try {
    execSync(`npx hyperframes render --output "${outputPath}" --fps 30`, {
      cwd: tmpDir,
      timeout: 120_000,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return NextResponse.json({
      error: `Render failed: ${err instanceof Error ? err.message : "unknown"}`
    }, { status: 500 });
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (!fs.existsSync(outputPath)) {
    return NextResponse.json({ error: "No output file produced" }, { status: 500 });
  }

  const videoUrl = `/videos/${filename}`;
  const updated = await updatePlan(planId, {
    videoUrl,
    videoEngine: "hyperframes",
    videoRenderedAt: new Date().toISOString(),
    currentStage: "video",
  });

  return NextResponse.json({ videoUrl, plan: updated });
}
