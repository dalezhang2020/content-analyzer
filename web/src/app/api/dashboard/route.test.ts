import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockListHistory } = vi.hoisted(() => ({
  mockListHistory: vi.fn(),
}));

vi.mock("@/lib/history", () => ({
  listHistory: mockListHistory,
}));

import { GET } from "./route";
import type { HistoryEntry } from "@/lib/history";
import type { AnalysisResult } from "@/lib/types";

function makeEntry(overrides: Partial<HistoryEntry> & { id: string }): HistoryEntry {
  return {
    url: "https://example.com",
    platform: "xiaohongshu",
    analyzedAt: new Date().toISOString(),
    result: {
      metadata: { video_id: "v1", title: "Test", channel: null, publish_date: null, duration_seconds: null, view_count: null },
      transcript: null,
      comments: null,
      image_analysis: null,
      hook: null,
      structure: null,
      takeaways: null,
      reusable_angles: null,
      keywords: [],
      content_style: null,
      audience_intent: null,
      engagement_hooks: null,
      cta_signals: null,
      adaptation_ideas: null,
      warnings: [],
    },
    ...overrides,
  };
}

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/dashboard", { method: "GET" });
}

describe("GET /api/dashboard", () => {
  beforeEach(() => {
    mockListHistory.mockReset();
  });

  describe("keyword counting logic", () => {
    it("counts keywords across multiple entries and sorts by frequency", async () => {
      mockListHistory.mockResolvedValue([
        makeEntry({ id: "h_1", result: { keywords: ["AI", "编程", "工具"] } as unknown as AnalysisResult }),
        makeEntry({ id: "h_2", result: { keywords: ["AI", "编程", "效率"] } as unknown as AnalysisResult }),
        makeEntry({ id: "h_3", result: { keywords: ["AI", "设计", "工具"] } as unknown as AnalysisResult }),
      ]);

      const res = await GET(makeRequest());
      const data = await res.json();

      expect(data.topKeywords[0]).toEqual({ keyword: "AI", count: 3 });
      expect(data.topKeywords[1]).toEqual({ keyword: "编程", count: 2 });
      expect(data.topKeywords[2]).toEqual({ keyword: "工具", count: 2 });
    });

    it("limits keywords to top 10", async () => {
      // Create an entry with 15 unique keywords
      const keywords = Array.from({ length: 15 }, (_, i) => `keyword_${i + 1}`);
      mockListHistory.mockResolvedValue([
        makeEntry({ id: "h_1", result: { keywords } as unknown as AnalysisResult }),
      ]);

      const res = await GET(makeRequest());
      const data = await res.json();

      expect(data.topKeywords).toHaveLength(10);
    });

    it("ignores single-character keywords", async () => {
      mockListHistory.mockResolvedValue([
        makeEntry({ id: "h_1", result: { keywords: ["A", "AI", "编程", "B"] } as unknown as AnalysisResult }),
      ]);

      const res = await GET(makeRequest());
      const data = await res.json();

      // Only "AI" and "编程" should be counted (length > 1)
      expect(data.topKeywords).toHaveLength(2);
      expect(data.topKeywords.map((k: { keyword: string }) => k.keyword)).toContain("AI");
      expect(data.topKeywords.map((k: { keyword: string }) => k.keyword)).toContain("编程");
    });

    it("handles entries with no keywords gracefully", async () => {
      mockListHistory.mockResolvedValue([
        makeEntry({ id: "h_1", result: { keywords: null } as unknown as AnalysisResult }),
        makeEntry({ id: "h_2", result: { keywords: undefined } as unknown as AnalysisResult }),
        makeEntry({ id: "h_3", result: { keywords: ["valid"] } as unknown as AnalysisResult }),
      ]);

      const res = await GET(makeRequest());
      const data = await res.json();

      expect(data.topKeywords).toHaveLength(1);
      expect(data.topKeywords[0]).toEqual({ keyword: "valid", count: 1 });
    });

    it("handles entries with non-string keyword values", async () => {
      mockListHistory.mockResolvedValue([
        makeEntry({ id: "h_1", result: { keywords: ["valid", 123, null, "also_valid"] } as unknown as AnalysisResult }),
      ]);

      const res = await GET(makeRequest());
      const data = await res.json();

      expect(data.topKeywords).toHaveLength(2);
      const kwNames = data.topKeywords.map((k: { keyword: string }) => k.keyword);
      expect(kwNames).toContain("valid");
      expect(kwNames).toContain("also_valid");
    });
  });

  describe("style distribution calculation", () => {
    it("counts content styles across entries", async () => {
      mockListHistory.mockResolvedValue([
        makeEntry({ id: "h_1", result: { content_style: "tutorial", keywords: [] } as unknown as AnalysisResult }),
        makeEntry({ id: "h_2", result: { content_style: "tutorial", keywords: [] } as unknown as AnalysisResult }),
        makeEntry({ id: "h_3", result: { content_style: "roundup", keywords: [] } as unknown as AnalysisResult }),
        makeEntry({ id: "h_4", result: { content_style: "explainer", keywords: [] } as unknown as AnalysisResult }),
      ]);

      const res = await GET(makeRequest());
      const data = await res.json();

      expect(data.styleDistribution).toEqual({
        tutorial: 2,
        roundup: 1,
        explainer: 1,
      });
    });

    it("ignores entries with null or empty content_style", async () => {
      mockListHistory.mockResolvedValue([
        makeEntry({ id: "h_1", result: { content_style: "tutorial", keywords: [] } as unknown as AnalysisResult }),
        makeEntry({ id: "h_2", result: { content_style: null, keywords: [] } as unknown as AnalysisResult }),
        makeEntry({ id: "h_3", result: { content_style: "", keywords: [] } as unknown as AnalysisResult }),
      ]);

      const res = await GET(makeRequest());
      const data = await res.json();

      expect(data.styleDistribution).toEqual({ tutorial: 1 });
    });
  });

  describe("platform breakdown", () => {
    it("counts entries by platform", async () => {
      mockListHistory.mockResolvedValue([
        makeEntry({ id: "h_1", platform: "xiaohongshu" }),
        makeEntry({ id: "h_2", platform: "xiaohongshu" }),
        makeEntry({ id: "h_3", platform: "youtube" }),
      ]);

      const res = await GET(makeRequest());
      const data = await res.json();

      expect(data.totalAnalyses).toBe(3);
      expect(data.byPlatform).toEqual({ xiaohongshu: 2, youtube: 1 });
    });

    it("returns zero totals for empty history", async () => {
      mockListHistory.mockResolvedValue([]);

      const res = await GET(makeRequest());
      const data = await res.json();

      expect(data.totalAnalyses).toBe(0);
      expect(data.byPlatform).toEqual({});
      expect(data.topKeywords).toEqual([]);
      expect(data.styleDistribution).toEqual({});
      expect(data.recentAnalyses).toEqual([]);
    });
  });

  describe("recent analyses", () => {
    it("returns only the 5 most recent entries", async () => {
      const entries = Array.from({ length: 8 }, (_, i) =>
        makeEntry({
          id: `h_${i}`,
          analyzedAt: new Date(2025, 0, i + 1).toISOString(),
          result: { metadata: { video_id: `v${i}`, title: `Entry ${i}`, channel: null, publish_date: null, duration_seconds: null, view_count: null }, keywords: [] } as unknown as AnalysisResult,
        })
      );
      // listHistory returns sorted by date desc already
      mockListHistory.mockResolvedValue(entries.reverse());

      const res = await GET(makeRequest());
      const data = await res.json();

      expect(data.recentAnalyses).toHaveLength(5);
      // First entry should be the most recent (h_7)
      expect(data.recentAnalyses[0].id).toBe("h_7");
    });

    it("uses URL as title fallback when metadata title is missing", async () => {
      mockListHistory.mockResolvedValue([
        makeEntry({
          id: "h_1",
          url: "https://example.com/video",
          result: { metadata: { video_id: "v1", title: null, channel: null, publish_date: null, duration_seconds: null, view_count: null }, keywords: [] } as unknown as AnalysisResult,
        }),
      ]);

      const res = await GET(makeRequest());
      const data = await res.json();

      expect(data.recentAnalyses[0].title).toBe("https://example.com/video");
    });

    it("includes id, title, platform, and analyzedAt in recent entries", async () => {
      const analyzedAt = "2025-06-01T12:00:00.000Z";
      mockListHistory.mockResolvedValue([
        makeEntry({
          id: "h_1",
          platform: "youtube",
          analyzedAt,
          result: { metadata: { video_id: "v1", title: "My Video", channel: null, publish_date: null, duration_seconds: null, view_count: null }, keywords: [] } as unknown as AnalysisResult,
        }),
      ]);

      const res = await GET(makeRequest());
      const data = await res.json();

      expect(data.recentAnalyses[0]).toEqual({
        id: "h_1",
        title: "My Video",
        platform: "youtube",
        analyzedAt,
      });
    });
  });

  describe("performance with large history sets", () => {
    it("handles 500+ entries and responds within 2 seconds", async () => {
      const entries = Array.from({ length: 600 }, (_, i) =>
        makeEntry({
          id: `h_${i}`,
          platform: i % 2 === 0 ? "xiaohongshu" : "youtube",
          analyzedAt: new Date(2025, 0, 1, 0, 0, i).toISOString(),
          result: {
            metadata: { video_id: `v${i}`, title: `Entry ${i}`, channel: null, publish_date: null, duration_seconds: null, view_count: null },
            keywords: [`kw_${i % 20}`, `kw_${(i + 5) % 20}`, `kw_${(i + 10) % 20}`],
            content_style: ["tutorial", "roundup", "explainer", "review", "entertainment"][i % 5],
            warnings: [],
          } as unknown as AnalysisResult,
        })
      );
      mockListHistory.mockResolvedValue(entries);

      const start = performance.now();
      const res = await GET(makeRequest());
      const data = await res.json();
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(2000);
      expect(data.totalAnalyses).toBe(600);
      expect(data.topKeywords).toHaveLength(10);
      expect(data.recentAnalyses).toHaveLength(5);
      expect(Object.keys(data.styleDistribution)).toHaveLength(5);
    });
  });
});
