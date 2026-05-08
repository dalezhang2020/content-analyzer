import { NextRequest } from "next/server";
import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * POST /api/video
 * Body: { result: AnalysisResult }
 *
 * Generates a HyperFrames video composition, renders to MP4,
 * and returns the video file path for serving.
 */

export async function POST(request: NextRequest) {
  const { result } = await request.json();

  if (!result || !result.metadata) {
    return new Response(JSON.stringify({ error: "result is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const projectRoot =
    process.env.PROJECT_ROOT ??
    path.resolve(process.cwd(), process.cwd().endsWith("/web") ? ".." : "../content-analyzer");

  const venvPython = path.join(projectRoot, ".venv", "bin", "python");

  // Create a stable output directory under web/public/videos/
  const videosDir = path.join(process.cwd(), "public", "videos");
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }

  // Use a hash-like id for the video filename
  const videoId = `video-${Date.now()}`;
  const compositionDir = path.join(os.tmpdir(), `ca-${videoId}`);
  const mp4Filename = `${videoId}.mp4`;
  const mp4OutputPath = path.join(videosDir, mp4Filename);

  // Step 1: Generate HyperFrames HTML composition
  const genScript = `
import json, sys
from pathlib import Path
from content_analyzer.models import AnalysisResult
from content_analyzer.video import generate_video_composition

result_data = json.loads(sys.stdin.read())
result = AnalysisResult(**result_data)

out_dir = Path("${compositionDir.replace(/\\/g, "\\\\")}")
index_path = generate_video_composition(result, out_dir)
print(str(out_dir))
`;

  // Generate composition
  const genResult = await runPython(venvPython, genScript, JSON.stringify(result), projectRoot);
  if (genResult.error) {
    return new Response(JSON.stringify({ error: genResult.error }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Step 2: Render to MP4 with HyperFrames
  try {
    execSync(
      `npx hyperframes render --output "${mp4OutputPath}" --fps 30`,
      {
        cwd: compositionDir,
        timeout: 120_000,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Render failed";
    return new Response(JSON.stringify({ error: `Render failed: ${msg}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Clean up temp composition dir
  fs.rmSync(compositionDir, { recursive: true, force: true });

  // Return the public URL to the video
  if (!fs.existsSync(mp4OutputPath)) {
    return new Response(JSON.stringify({ error: "Render produced no output file" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stats = fs.statSync(mp4OutputPath);

  return new Response(
    JSON.stringify({
      url: `/videos/${mp4Filename}`,
      size: stats.size,
      filename: mp4Filename,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

// Helper: run a Python script with stdin input
function runPython(
  pythonPath: string,
  script: string,
  stdin: string,
  cwd: string
): Promise<{ output?: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(pythonPath, ["-c", script], {
      cwd,
      env: {
        ...process.env,
        PATH: `${path.dirname(pythonPath)}:${process.env.PATH}`,
        VIRTUAL_ENV: path.dirname(path.dirname(pythonPath)),
      },
    });

    proc.stdin.write(stdin);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ error: "Python script timed out" });
    }, 30_000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ output: stdout.trim() });
      } else {
        const errMsg = stderr.trim().split("\n").pop() || `Exit code ${code}`;
        resolve({ error: errMsg });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ error: err.message });
    });
  });
}
