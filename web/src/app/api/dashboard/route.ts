import { NextRequest, NextResponse } from "next/server";
import { listHistory } from "@/lib/history";
import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Check adapter health by verifying the Python venv and adapter modules exist.
 */
function checkAdapterHealth(): {
  youtube: { ok: boolean; message: string };
  xiaohongshu: { ok: boolean; message: string };
} {
  const projectRoot = resolve(process.cwd(), "..");
  const venvExists = existsSync(resolve(projectRoot, ".venv"));

  if (!venvExists) {
    return {
      youtube: { ok: false, message: "Python venv not found" },
      xiaohongshu: { ok: false, message: "Python venv not found" },
    };
  }

  // Check if adapter modules exist
  const youtubeAdapterPath = resolve(
    projectRoot,
    "src/content_analyzer/adapters/youtube_adapter.py"
  );
  const xiaohongshuAdapterPath = resolve(
    projectRoot,
    "src/content_analyzer/adapters/xiaohongshu_adapter.py"
  );

  const youtubeOk = existsSync(youtubeAdapterPath);
  const xiaohongshuOk = existsSync(xiaohongshuAdapterPath);

  return {
    youtube: {
      ok: youtubeOk,
      message: youtubeOk ? "Adapter available" : "Adapter module not found",
    },
    xiaohongshu: {
      ok: xiaohongshuOk,
      message: xiaohongshuOk ? "Adapter available" : "Adapter module not found",
    },
  };
}

/**
 * GET /api/dashboard
 * Returns aggregated stats from history for the dashboard page.
 */
export async function GET(_request: NextRequest) {
  const entries = await listHistory();

  // Total by platform
  const byPlatform: Record<string, number> = {};
  const keywordCounts: Record<string, number> = {};
  const styleCounts: Record<string, number> = {};

  for (const entry of entries) {
    // Platform count
    byPlatform[entry.platform] = (byPlatform[entry.platform] || 0) + 1;

    // Keywords
    const keywords = entry.result?.keywords;
    if (Array.isArray(keywords)) {
      for (const kw of keywords) {
        if (typeof kw === "string" && kw.length > 1) {
          keywordCounts[kw] = (keywordCounts[kw] || 0) + 1;
        }
      }
    }

    // Content style
    const style = entry.result?.content_style;
    if (typeof style === "string" && style) {
      styleCounts[style] = (styleCounts[style] || 0) + 1;
    }
  }

  // Top 10 keywords
  const topKeywords = Object.entries(keywordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([keyword, count]) => ({ keyword, count }));

  // Recent 5
  const recentAnalyses = entries.slice(0, 5).map((e) => ({
    id: e.id,
    title: e.result?.metadata?.title || e.url,
    platform: e.platform,
    analyzedAt: e.analyzedAt,
  }));

  const adapterHealth = checkAdapterHealth();

  return NextResponse.json({
    totalAnalyses: entries.length,
    byPlatform,
    recentAnalyses,
    topKeywords,
    styleDistribution: styleCounts,
    adapterHealth,
  });
}
