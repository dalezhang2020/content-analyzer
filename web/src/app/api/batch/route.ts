import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { isLocalEnv, localOnlyResponse } from "@/lib/env";

/**
 * POST /api/batch — requires local Python venv, returns 503 on Vercel.
 */

const MAX_URLS = 20;
const MAX_CONCURRENT = 5;

export async function POST(request: NextRequest) {
  if (!isLocalEnv()) return localOnlyResponse("Batch analysis");

  let body: { urls?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { urls } = body;

  if (!Array.isArray(urls) || urls.length === 0) {
    return new Response(JSON.stringify({ error: "urls must be a non-empty array" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (urls.length > MAX_URLS) {
    return new Response(JSON.stringify({ error: `Maximum ${MAX_URLS} URLs per batch` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate each URL
  const validUrls: string[] = [];
  for (const url of urls) {
    if (typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Each URL must be a string" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const trimmed = url.trim();
    if (!trimmed || !/^https?:\/\/.+/i.test(trimmed)) {
      return new Response(JSON.stringify({ error: `Invalid URL: ${trimmed || "(empty)"}` }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    validUrls.push(trimmed);
  }

  const projectRoot =
    process.env.PROJECT_ROOT ??
    path.resolve(process.cwd(), process.cwd().endsWith("/web") ? ".." : "../content-analyzer");
  const analyzeCmd = path.join(projectRoot, ".venv", "bin", "analyze");

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      };

      let success = 0;
      let failed = 0;

      // Process in batches of MAX_CONCURRENT
      for (let i = 0; i < validUrls.length; i += MAX_CONCURRENT) {
        const batch = validUrls.slice(i, i + MAX_CONCURRENT);
        const promises = batch.map((url) => processUrl(url, analyzeCmd, projectRoot, send));
        const results = await Promise.allSettled(promises);

        for (const r of results) {
          if (r.status === "fulfilled" && r.value) {
            success++;
          } else {
            failed++;
          }
        }
      }

      send({ summary: { total: validUrls.length, success, failed } });
      controller.close();
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

function processUrl(
  url: string,
  analyzeCmd: string,
  projectRoot: string,
  send: (data: Record<string, unknown>) => void
): Promise<boolean> {
  return new Promise((resolve) => {
    send({ url, status: "processing", stage: "fetch" });

    let stdout = "";
    let stderrBuf = "";

    const proc = spawn(analyzeCmd, ["analyze", "--staged", url], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${path.join(projectRoot, ".venv", "bin")}:${process.env.PATH}`,
        VIRTUAL_ENV: path.join(projectRoot, ".venv"),
      },
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.__stage__) {
            send({ url, status: "processing", stage: parsed.__stage__ });
          }
        } catch {
          // ignore
        }
      }
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      send({ url, status: "error", error: "Timed out after 120 seconds" });
      resolve(false);
    }, 120_000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 && stdout.trim()) {
        try {
          const result = JSON.parse(stdout);
          send({ url, status: "done", result });

          // Auto-save to history (fire-and-forget via internal fetch)
          const historyUrl = `http://localhost:${process.env.PORT || 3000}/api/history`;
          fetch(historyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, result }),
          }).catch(() => {});

          resolve(true);
        } catch {
          send({ url, status: "error", error: "Failed to parse output" });
          resolve(false);
        }
      } else {
        const errLine = stderrBuf.trim().split("\n").pop() || `Exit code ${code}`;
        send({ url, status: "error", error: errLine });
        resolve(false);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      send({ url, status: "error", error: err.message });
      resolve(false);
    });
  });
}
