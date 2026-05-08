import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { getHistoryById } from "@/lib/history";

/**
 * POST /api/plans/generate-script
 * Body: { sourceAnalysisId: string, angle?: string }
 *
 * Generates a structured video script (angle + outline + full script)
 * from an analysis result using the LLM.
 */
export async function POST(request: NextRequest) {
  let body: { sourceAnalysisId?: string; angle?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { sourceAnalysisId, angle: userAngle } = body;
  if (!sourceAnalysisId) {
    return NextResponse.json({ error: "sourceAnalysisId required" }, { status: 400 });
  }

  const entry = await getHistoryById(sourceAnalysisId);
  if (!entry) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }

  const projectRoot =
    process.env.PROJECT_ROOT ??
    path.resolve(process.cwd(), process.cwd().endsWith("/web") ? ".." : "../content-analyzer");
  const pythonBin = path.join(projectRoot, ".venv", "bin", "python");

  // Call Python with analysis data to generate a script
  const script = `
import json, sys, os
from openai import OpenAI

data = json.loads(sys.stdin.read())
analysis = data["analysis"]
user_angle = data.get("user_angle", "")

api_key = os.environ.get("OPENAI_API_KEY")
if not api_key:
    print(json.dumps({"error": "OPENAI_API_KEY not set"}))
    sys.exit(1)

client = OpenAI(api_key=api_key)
model = os.environ.get("OPENAI_MODEL", "gpt-5.4-mini")

prompt = f"""You are a video script writer. Based on the content analysis below, create a structured 25-30 second video script.

{"User's direction: " + user_angle if user_angle else "Pick the most compelling angle."}

Analysis summary: {analysis.get("summary", "N/A")}
Key points: {json.dumps(analysis.get("key_points", []), ensure_ascii=False)}
Data: {json.dumps(analysis.get("data_points", []), ensure_ascii=False)}
Unique angle: {analysis.get("unique_angle", "N/A")}
Target audience: {analysis.get("target_audience", "N/A")}
Content style: {analysis.get("content_style", "N/A")}

Return JSON:
{{
  "angle": "Your chosen angle/切入点 in one sentence (what makes this video different)",
  "outline": [
    {{"id": "s1", "type": "hook", "title": "场景标题", "duration": 3, "content": "场景的具体内容要点（2-4 行）"}},
    {{"id": "s2", "type": "content", "title": "...", "duration": 5, "content": "..."}},
    {{"id": "s3", "type": "data", "title": "...", "duration": 4, "content": "..."}},
    {{"id": "s4", "type": "action", "title": "...", "duration": 4, "content": "..."}},
    {{"id": "s5", "type": "closing", "title": "...", "duration": 3, "content": "..."}}
  ],
  "script": "完整的视频文案（可直接念出来的口播稿，包含所有场景的旁白和画面描述标注）"
}}

Rules:
- 5-7 scenes total
- Scene types: hook (opening), content (main teaching), data (numbers/evidence), action (call to action), closing (wrap-up)
- Each scene's content should be CONCRETE (specific numbers, quotes, steps) not generic
- Total duration 25-30 seconds
- Language: Chinese if analysis is Chinese, English otherwise
- Output only JSON, no markdown fences"""

resp = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": prompt}],
    temperature=0.5,
)

content = resp.choices[0].message.content.strip()
if content.startswith("\`\`\`"):
    content = content.split("\\n", 1)[1] if "\\n" in content else content[3:]
if content.endswith("\`\`\`"):
    content = content[:-3]
print(content.strip())
`;

  return new Promise<Response>((resolve) => {
    const proc = spawn(pythonBin, ["-c", script], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${path.join(projectRoot, ".venv", "bin")}:${process.env.PATH}`,
        VIRTUAL_ENV: path.join(projectRoot, ".venv"),
      },
    });

    proc.stdin.write(JSON.stringify({ analysis: entry.result, user_angle: userAngle }));
    proc.stdin.end();

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve(NextResponse.json({ error: "Script generation timed out" }, { status: 504 }));
    }, 60_000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 && stdout.trim()) {
        try {
          const result = JSON.parse(stdout);
          resolve(NextResponse.json(result));
        } catch (e) {
          resolve(NextResponse.json({ error: "Failed to parse script output", raw: stdout }, { status: 500 }));
        }
      } else {
        resolve(NextResponse.json({ error: stderr.trim().split("\n").pop() || `Exit ${code}` }, { status: 500 }));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve(NextResponse.json({ error: err.message }, { status: 500 }));
    });
  });
}
