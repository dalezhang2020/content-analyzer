import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { isLocalEnv, localOnlyResponse } from "@/lib/env";

/**
 * POST /api/analyze
 * Body: { url: string }
 *
 * Streams pipeline stage updates as NDJSON lines, then the final result.
 * Requires local Python venv — returns 503 on Vercel.
 */

const ORDERED_STAGES = ["input", "fetch", "extract", "analyze", "report", "done"] as const;
type Stage = (typeof ORDERED_STAGES)[number];

export async function POST(request: NextRequest) {
  if (!isLocalEnv()) return localOnlyResponse("Content analysis");

  const { url } = await request.json();

  if (!url || typeof url !== "string") {
    return new Response(JSON.stringify({ error: "url is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Input sanitization: length limit, control character filtering
  const trimmedUrl = url.trim();
  if (trimmedUrl.length > 2048) {
    return new Response(JSON.stringify({ error: "URL too long (max 2048 characters)" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Reject control characters (except normal whitespace already trimmed)
  if (/[\x00-\x1f\x7f]/.test(trimmedUrl)) {
    return new Response(JSON.stringify({ error: "URL contains invalid characters" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!/^https?:\/\/.+/i.test(trimmedUrl)) {
    return new Response(JSON.stringify({ error: "Invalid URL format" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // PROJECT_ROOT env var allows flexible deployment; defaults to the parent of web/
  const projectRoot =
    process.env.PROJECT_ROOT ??
    path.resolve(process.cwd(), process.cwd().endsWith("/web") ? ".." : "../content-analyzer");
  const analyzeCmd = path.join(projectRoot, ".venv", "bin", "analyze");
  console.log("[analyze] cwd:", process.cwd());
  console.log("[analyze] projectRoot:", projectRoot);
  console.log("[analyze] analyzeCmd:", analyzeCmd);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      };

      let stdout = "";
      let stderrBuf = "";
      let lastStageIdx = -1;

      const proc = spawn(analyzeCmd, ["analyze", "--staged", trimmedUrl], {
        cwd: projectRoot,
        env: {
          ...process.env,
          PATH: `${path.join(projectRoot, ".venv", "bin")}:${process.env.PATH}`,
          VIRTUAL_ENV: path.join(projectRoot, ".venv"),
        },
      });

      // Parse structured stage markers from stderr
      proc.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.__stage__) {
              const idx = ORDERED_STAGES.indexOf(parsed.__stage__ as Stage);
              // Only emit if this stage is strictly forward from the last emitted
              if (idx > lastStageIdx) {
                lastStageIdx = idx;
                send({ stage: parsed.__stage__ });
              }
            }
          } catch {
            // Non-JSON stderr lines are ignored (normal log output)
          }
        }
      });

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      // Timeout after 120s
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        send({ error: "Analysis timed out after 120 seconds" });
        controller.close();
      }, 120_000);

      proc.on("close", (code) => {
        clearTimeout(timeout);

        // Process any remaining stderr buffer
        if (stderrBuf.trim()) {
          try {
            const parsed = JSON.parse(stderrBuf);
            if (parsed.__stage__) {
              const idx = ORDERED_STAGES.indexOf(parsed.__stage__ as Stage);
              if (idx > lastStageIdx) {
                lastStageIdx = idx;
                send({ stage: parsed.__stage__ });
              }
            }
          } catch {
            // ignore
          }
        }

        if (code === 0 && stdout.trim()) {
          try {
            const result = JSON.parse(stdout);
            // Ensure done is sent if not already
            if (lastStageIdx < ORDERED_STAGES.indexOf("done")) {
              send({ stage: "done" });
            }
            send({ result });
          } catch {
            send({ error: "Failed to parse analysis output" });
          }
        } else {
          const errLines = stderrBuf.trim() || "";
          const lastLine = errLines.split("\n").pop() || `Process exited with code ${code}`;
          send({ error: lastLine });
        }
        controller.close();
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        send({ error: err.message });
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    },
  });
}
