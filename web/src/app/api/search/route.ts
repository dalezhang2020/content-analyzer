import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { isLocalEnv, localOnlyResponse } from "@/lib/env";

/**
 * POST /api/search — requires local Python venv, returns 503 on Vercel.
 */

const VALID_PLATFORMS = ["xiaohongshu", "youtube"] as const;
const VALID_SORTS = ["general", "popular", "latest"] as const;
const MAX_KEYWORD_LENGTH = 200;
const TIMEOUT_MS = 15_000;

type Platform = (typeof VALID_PLATFORMS)[number];
type Sort = (typeof VALID_SORTS)[number];

export async function POST(request: NextRequest) {
  if (!isLocalEnv()) return localOnlyResponse("Content search");

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { keyword, platform, sort = "general", page = 1 } = body as {
    keyword?: string;
    platform?: string;
    sort?: string;
    page?: number;
  };

  // --- Input validation ---

  // keyword: required, string, max 100 chars, no control characters
  if (!keyword || typeof keyword !== "string") {
    return new Response(JSON.stringify({ error: "keyword is required and must be a string" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const trimmedKeyword = keyword.trim();
  if (trimmedKeyword.length === 0) {
    return new Response(JSON.stringify({ error: "keyword must not be empty" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (trimmedKeyword.length > MAX_KEYWORD_LENGTH) {
    return new Response(
      JSON.stringify({ error: `keyword too long (max ${MAX_KEYWORD_LENGTH} characters)` }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Reject control characters
  if (/[\x00-\x1f\x7f]/.test(trimmedKeyword)) {
    return new Response(JSON.stringify({ error: "keyword contains invalid characters" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // platform: required, must be in enum
  if (!platform || typeof platform !== "string") {
    return new Response(JSON.stringify({ error: "platform is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!VALID_PLATFORMS.includes(platform as Platform)) {
    return new Response(
      JSON.stringify({
        error: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(", ")}`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // sort: optional, must be in enum
  if (typeof sort !== "string" || !VALID_SORTS.includes(sort as Sort)) {
    return new Response(
      JSON.stringify({
        error: `Invalid sort. Must be one of: ${VALID_SORTS.join(", ")}`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // page: optional, must be positive integer
  const pageNum = Number(page);
  if (!Number.isInteger(pageNum) || pageNum < 1) {
    return new Response(JSON.stringify({ error: "page must be a positive integer" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- Call Python backend via subprocess ---

  const projectRoot =
    process.env.PROJECT_ROOT ??
    path.resolve(process.cwd(), process.cwd().endsWith("/web") ? ".." : "../content-analyzer");

  const pythonBin = path.join(projectRoot, ".venv", "bin", "python");

  const script = `
import json, sys
from content_analyzer.pipeline import search
keyword = sys.argv[1]
platform = sys.argv[2]
page = int(sys.argv[3])
sort = sys.argv[4]
result = search(keyword, platform=platform, page=page, sort=sort)
output = {
    "keyword": result.keyword,
    "platform": result.platform,
    "total": result.total,
    "items": [{"note_id": i.note_id, "title": i.title, "url": i.url, "author": i.author, "likes": i.likes, "comments": i.comments, "collects": i.collects, "content_type": i.content_type, "snippet": i.snippet} for i in result.items],
    "warnings": result.warnings,
}
print(json.dumps(output, ensure_ascii=False))
`.trim();

  return new Promise<Response>((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(pythonBin, ["-c", script, trimmedKeyword, platform, String(pageNum), sort], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${path.join(projectRoot, ".venv", "bin")}:${process.env.PATH}`,
        VIRTUAL_ENV: path.join(projectRoot, ".venv"),
      },
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // 15-second timeout
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve(
        new Response(JSON.stringify({ error: "Search timed out after 15 seconds" }), {
          status: 504,
          headers: { "Content-Type": "application/json" },
        })
      );
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timeout);

      if (code === 0 && stdout.trim()) {
        try {
          const result = JSON.parse(stdout);
          resolve(
            new Response(JSON.stringify(result), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          );
        } catch {
          resolve(
            new Response(JSON.stringify({ error: "Failed to parse search output" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            })
          );
        }
      } else {
        const lastLine = stderr.trim().split("\n").pop() || `Process exited with code ${code}`;
        resolve(
          new Response(JSON.stringify({ error: lastLine }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve(
        new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      );
    });
  });
}
