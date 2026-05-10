import { NextRequest, NextResponse } from "next/server";
import { listHistory } from "@/lib/history";
import { sql, isNeonConfigured } from "@/lib/db";
import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Check adapter health by verifying the Python venv and adapter modules exist.
 * Only meaningful in local dev — on Vercel this always returns false.
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

  const youtubeOk = existsSync(resolve(projectRoot, "src/content_analyzer/adapters/youtube_adapter.py"));
  const xiaohongshuOk = existsSync(resolve(projectRoot, "src/content_analyzer/adapters/xiaohongshu_adapter.py"));

  return {
    youtube: { ok: youtubeOk, message: youtubeOk ? "Adapter available" : "Adapter module not found" },
    xiaohongshu: { ok: xiaohongshuOk, message: xiaohongshuOk ? "Adapter available" : "Adapter module not found" },
  };
}

/**
 * GET /api/dashboard
 * Phase 2: aggregates from Neon via SQL when available, falls back to
 * reading all local JSON files.
 */
export async function GET(_request: NextRequest) {
  // ── Neon path (fast SQL aggregation) ──────────────────────────────────────
  if (isNeonConfigured()) {
    try {
      // Total + by platform
      const platformRows = await sql<{ platform: string; count: string }>`
        SELECT platform, COUNT(*)::text AS count
        FROM content_analyzer.analysis_history
        GROUP BY platform
      `;
      const byPlatform: Record<string, number> = {};
      let totalAnalyses = 0;
      for (const row of platformRows) {
        byPlatform[row.platform] = Number(row.count);
        totalAnalyses += Number(row.count);
      }

      // Top 10 keywords (unnest the keywords array)
      const kwRows = await sql<{ keyword: string; count: string }>`
        SELECT kw AS keyword, COUNT(*)::text AS count
        FROM content_analyzer.analysis_history,
             UNNEST(keywords) AS kw
        WHERE kw IS NOT NULL AND LENGTH(kw) > 1
        GROUP BY kw
        ORDER BY count DESC
        LIMIT 10
      `;
      const topKeywords = kwRows.map((r) => ({ keyword: r.keyword, count: Number(r.count) }));

      // Style distribution
      const styleRows = await sql<{ content_style: string; count: string }>`
        SELECT content_style, COUNT(*)::text AS count
        FROM content_analyzer.analysis_history
        WHERE content_style IS NOT NULL AND content_style != ''
        GROUP BY content_style
        ORDER BY count DESC
      `;
      const styleDistribution: Record<string, number> = {};
      for (const row of styleRows) {
        styleDistribution[row.content_style] = Number(row.count);
      }

      // Recent 5 analyses
      const recentRows = await sql<{
        history_id: string;
        title: string | null;
        url: string;
        platform: string;
        analyzed_at: string;
      }>`
        SELECT history_id, title, url, platform,
               analyzed_at::text AS analyzed_at
        FROM content_analyzer.analysis_history
        ORDER BY analyzed_at DESC
        LIMIT 5
      `;
      const recentAnalyses = recentRows.map((r) => ({
        id: r.history_id,
        title: r.title || r.url,
        platform: r.platform,
        analyzedAt: r.analyzed_at,
      }));

      return NextResponse.json({
        totalAnalyses,
        byPlatform,
        recentAnalyses,
        topKeywords,
        styleDistribution,
        adapterHealth: checkAdapterHealth(),
      });
    } catch (err) {
      console.warn("[dashboard] Neon query failed, falling back to FS:", err instanceof Error ? err.message : err);
    }
  }

  // ── Local FS fallback ──────────────────────────────────────────────────────
  const entries = await listHistory();

  const byPlatform: Record<string, number> = {};
  const keywordCounts: Record<string, number> = {};
  const styleCounts: Record<string, number> = {};

  for (const entry of entries) {
    byPlatform[entry.platform] = (byPlatform[entry.platform] || 0) + 1;

    const keywords = entry.result?.keywords;
    if (Array.isArray(keywords)) {
      for (const kw of keywords) {
        if (typeof kw === "string" && kw.length > 1) {
          keywordCounts[kw] = (keywordCounts[kw] || 0) + 1;
        }
      }
    }

    const style = entry.result?.content_style;
    if (typeof style === "string" && style) {
      styleCounts[style] = (styleCounts[style] || 0) + 1;
    }
  }

  const topKeywords = Object.entries(keywordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([keyword, count]) => ({ keyword, count }));

  const recentAnalyses = entries.slice(0, 5).map((e) => ({
    id: e.id,
    title: e.result?.metadata?.title || e.url,
    platform: e.platform,
    analyzedAt: e.analyzedAt,
  }));

  return NextResponse.json({
    totalAnalyses: entries.length,
    byPlatform,
    recentAnalyses,
    topKeywords,
    styleDistribution: styleCounts,
    adapterHealth: checkAdapterHealth(),
  });
}
