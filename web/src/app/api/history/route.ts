import { NextRequest, NextResponse } from "next/server";
import { listHistory, saveHistory } from "@/lib/history";
import type { AnalysisResult } from "@/lib/types";

/** Valid platform filter values */
const VALID_PLATFORMS = ["xiaohongshu", "youtube"] as const;

/**
 * GET /api/history
 * Query params:
 *   - platform (optional): "xiaohongshu" | "youtube"
 *   - startDate (optional): ISO 8601 date string
 *   - endDate (optional): ISO 8601 date string
 *
 * Returns a list of history entries, sorted by most recent first.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const platform = searchParams.get("platform");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");

  // Validate platform filter
  if (platform && !VALID_PLATFORMS.includes(platform as (typeof VALID_PLATFORMS)[number])) {
    return NextResponse.json(
      { error: `Invalid platform filter. Must be one of: ${VALID_PLATFORMS.join(", ")}` },
      { status: 400 }
    );
  }

  // Validate date formats
  if (startDate && isNaN(Date.parse(startDate))) {
    return NextResponse.json(
      { error: "Invalid startDate format. Must be a valid ISO 8601 date." },
      { status: 400 }
    );
  }

  if (endDate && isNaN(Date.parse(endDate))) {
    return NextResponse.json(
      { error: "Invalid endDate format. Must be a valid ISO 8601 date." },
      { status: 400 }
    );
  }

  const entries = await listHistory({
    platform: platform || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
  });

  return NextResponse.json(entries);
}

/**
 * POST /api/history
 * Body: { url: string, result: AnalysisResult }
 *
 * Saves a new history entry. Returns the saved entry with generated ID and timestamp.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }

  const { url, result } = body as { url?: unknown; result?: unknown };

  // Validate url
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "url is required and must be a string" }, { status: 400 });
  }

  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    return NextResponse.json({ error: "url must not be empty" }, { status: 400 });
  }

  if (trimmedUrl.length > 2048) {
    return NextResponse.json(
      { error: "url too long (max 2048 characters)" },
      { status: 400 }
    );
  }

  // Reject control characters
  if (/[\x00-\x1f\x7f]/.test(trimmedUrl)) {
    return NextResponse.json(
      { error: "url contains invalid characters" },
      { status: 400 }
    );
  }

  if (!/^https?:\/\/.+/i.test(trimmedUrl)) {
    return NextResponse.json({ error: "Invalid URL format" }, { status: 400 });
  }

  // Validate result
  if (!result || typeof result !== "object") {
    return NextResponse.json(
      { error: "result is required and must be an object" },
      { status: 400 }
    );
  }

  const entry = await saveHistory(trimmedUrl, result as AnalysisResult);

  return NextResponse.json(entry, { status: 201 });
}
