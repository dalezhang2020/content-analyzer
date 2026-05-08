import { NextRequest, NextResponse } from "next/server";
import { getPlan, updatePlan } from "@/lib/plans";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * POST /api/plans/generate-html
 * Body: { planId: string, style?: string }
 *
 * Uses kiro-cli with claude-opus-4.7 to generate HTML following the
 * claude-design skill at .claude/skills/claude-design/SKILL.md.
 *
 * Kiro CLI can natively read files, so it picks up the skill contents
 * and references during generation.
 */

const MODEL = "claude-opus-4.7";
const TIMEOUT_MS = 180_000; // 3 minutes for LLM generation

export async function POST(request: NextRequest) {
  let body: { planId?: string; style?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { planId, style = "editorial" } = body;
  if (!planId) return NextResponse.json({ error: "planId required" }, { status: 400 });

  const plan = await getPlan(planId);
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

  const projectRoot =
    process.env.PROJECT_ROOT ??
    path.resolve(process.cwd(), process.cwd().endsWith("/web") ? ".." : "../content-analyzer");

  // Verify skill file exists
  const skillPath = path.join(projectRoot, ".claude", "skills", "claude-design", "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    return NextResponse.json({
      error: "claude-design skill not found at .claude/skills/claude-design/SKILL.md"
    }, { status: 500 });
  }

  // Build the outline summary for the prompt
  const outline = plan.outline || [];
  const outlineMd = outline.map((s, i) =>
    `- Scene ${i + 1} (${s.type || "content"}, ${s.duration || 4}s): **${s.title || ""}**\n  ${s.content || ""}`
  ).join("\n");
  const totalDuration = outline.reduce((sum, s) => sum + (s.duration || 4), 0);

  // Write plan summary to a temp file so kiro-cli can read it
  const planFile = path.join(os.tmpdir(), `plan-${planId}-${Date.now()}.md`);
  const planContent = `# Video Plan: ${plan.title}

## Angle
${plan.angle || "N/A"}

## Style
${style}

## Total duration
${totalDuration}s

## Scene Outline
${outlineMd}
`;
  fs.writeFileSync(planFile, planContent, "utf-8");

  // Output file for the generated HTML
  const outputFile = path.join(os.tmpdir(), `html-${planId}-${Date.now()}.html`);

  const prompt = `Read the Claude Design skill at ${skillPath} to learn the design principles you must follow.

Then read the video plan at ${planFile}.

Your task: generate a HyperFrames-compatible HTML composition based on the plan.

HyperFrames requirements:
1. Root element: \`<div id="root" data-composition-id="root" data-start="0" data-width="1920" data-height="1080">\`
2. Each scene: \`<div class="scene clip" data-start="X.X" data-duration="Y.Y" data-track-index="1">\` with timings summing to ${totalDuration}s
3. Include GSAP 3.14.2 from CDN: \`<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>\`
4. Create a paused timeline: \`const tl = gsap.timeline({ paused: true });\`
5. Register on window: \`window.__timelines = window.__timelines || {}; window.__timelines["root"] = tl;\`
6. End with \`tl.set({}, {}, ${totalDuration.toFixed(1)});\` to lock composition duration
7. All animations use \`tl.from(...)\` with absolute time position (3rd arg)

Design requirements (from claude-design skill):
- 1920x1080 resolution, body text ≥ 24px
- INFORMATION-DENSE — each scene must have rich content, not big empty frames
- Typography-first design (editorial style)
- Flat design, no drop shadows
- 2-3 color palette maximum with semantic use
- Use CSS Grid / Flexbox for layouts
- Use modern CSS: oklch() colors, text-wrap: pretty

Write ONLY the complete HTML file contents to ${outputFile}.
Do not print the HTML to stdout. Do not add commentary.
After writing the file, just confirm with "Done."`;

  return new Promise<Response>((resolve) => {
    const proc = spawn("kiro-cli", [
      "chat",
      "--no-interactive",
      "--model", MODEL,
      "--trust-all-tools",
      prompt,
    ], {
      cwd: projectRoot,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      try { fs.unlinkSync(planFile); } catch {}
      resolve(NextResponse.json({ error: "Kiro CLI timed out (3 min)" }, { status: 504 }));
    }, TIMEOUT_MS);

    proc.on("close", async (code) => {
      clearTimeout(timeout);
      try { fs.unlinkSync(planFile); } catch {}

      if (code !== 0) {
        resolve(NextResponse.json({
          error: `kiro-cli exited with code ${code}`,
          stderr: stderr.slice(0, 500),
          stdout: stdout.slice(0, 500),
        }, { status: 500 }));
        return;
      }

      // Read the generated HTML from the output file
      if (!fs.existsSync(outputFile)) {
        resolve(NextResponse.json({
          error: "Kiro did not write the output file",
          hint: "The LLM may have printed the HTML instead of writing it. Check stdout.",
          stdout: stdout.slice(-2000),
        }, { status: 500 }));
        return;
      }

      let htmlContent: string;
      try {
        htmlContent = fs.readFileSync(outputFile, "utf-8");
      } catch (err) {
        resolve(NextResponse.json({
          error: `Failed to read output: ${err instanceof Error ? err.message : "unknown"}`
        }, { status: 500 }));
        return;
      } finally {
        try { fs.unlinkSync(outputFile); } catch {}
      }

      // Basic sanity check
      if (!htmlContent.includes("data-composition-id") || htmlContent.length < 500) {
        resolve(NextResponse.json({
          error: "Generated HTML is invalid (missing composition structure or too short)",
          preview: htmlContent.slice(0, 500),
        }, { status: 500 }));
        return;
      }

      const updated = await updatePlan(plan.id, {
        htmlContent,
        htmlStyle: `${style} (kiro-cli + opus 4.7 + claude-design)`,
        htmlUpdatedAt: new Date().toISOString(),
        currentStage: "html",
      });

      resolve(NextResponse.json({ htmlContent, plan: updated }));
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      try { fs.unlinkSync(planFile); } catch {}
      resolve(NextResponse.json({
        error: `Failed to start kiro-cli: ${err.message}`,
      }, { status: 500 }));
    });
  });
}
