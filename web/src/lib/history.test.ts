import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AnalysisResult } from "./types";

// Mock node:fs/promises
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn();
const mockUnlink = vi.fn();
const mockReaddir = vi.fn();

vi.mock("node:fs", () => {
  const fsMock = {
    promises: {
      mkdir: (...args: unknown[]) => mockMkdir(...args),
      writeFile: (...args: unknown[]) => mockWriteFile(...args),
      readFile: (...args: unknown[]) => mockReadFile(...args),
      unlink: (...args: unknown[]) => mockUnlink(...args),
      readdir: (...args: unknown[]) => mockReaddir(...args),
    },
  };
  return { ...fsMock, default: fsMock };
});

// Import after mocking
import {
  saveHistory,
  getHistoryById,
  getHistory,
  deleteHistory,
  listHistory,
} from "./history";

/** Minimal AnalysisResult fixture for testing */
function makeResult(overrides?: Partial<AnalysisResult>): AnalysisResult {
  return {
    metadata: {
      video_id: "test123",
      title: "Test Video",
      channel: "Test Channel",
      publish_date: "2025-01-01",
      duration_seconds: 120,
      view_count: 1000,
    },
    transcript: null,
    comments: null,
    image_analysis: null,
    hook: "Test hook",
    structure: ["intro", "body", "outro"],
    takeaways: ["takeaway 1"],
    reusable_angles: ["angle 1"],
    keywords: ["test", "video"],
    content_style: "tutorial",
    audience_intent: "learn",
    engagement_hooks: ["hook 1"],
    cta_signals: ["subscribe"],
    adaptation_ideas: ["idea 1"],
    warnings: [],
    ...overrides,
  };
}

describe("history utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("saveHistory", () => {
    it("saves a history entry with auto-generated ID and timestamp", async () => {
      const url = "https://www.youtube.com/watch?v=abc123";
      const result = makeResult();

      const entry = await saveHistory(url, result);

      expect(entry.id).toBe(`h_${Date.now()}`);
      expect(entry.url).toBe(url);
      expect(entry.platform).toBe("youtube");
      expect(entry.analyzedAt).toBe("2025-06-01T10:00:00.000Z");
      expect(entry.result).toBe(result);
    });

    it("detects xiaohongshu platform from URL", async () => {
      const url = "https://www.xiaohongshu.com/explore/abc123";
      const result = makeResult();

      const entry = await saveHistory(url, result);

      expect(entry.platform).toBe("xiaohongshu");
    });

    it("detects xiaohongshu platform from xhslink URL", async () => {
      const url = "https://xhslink.com/abc123";
      const result = makeResult();

      const entry = await saveHistory(url, result);

      expect(entry.platform).toBe("xiaohongshu");
    });

    it("defaults to youtube for unknown URLs", async () => {
      const url = "https://example.com/video";
      const result = makeResult();

      const entry = await saveHistory(url, result);

      expect(entry.platform).toBe("youtube");
    });

    it("writes JSON file to the correct path", async () => {
      const url = "https://www.youtube.com/watch?v=abc123";
      const result = makeResult();

      await saveHistory(url, result);

      expect(mockWriteFile).toHaveBeenCalledOnce();
      const [filePath, content] = mockWriteFile.mock.calls[0];
      expect(filePath).toContain(`h_${Date.now()}.json`);
      expect(filePath).toContain("data/history");

      const parsed = JSON.parse(content);
      expect(parsed.id).toBe(`h_${Date.now()}`);
      expect(parsed.url).toBe(url);
    });

    it("ensures data directory exists before writing", async () => {
      const url = "https://www.youtube.com/watch?v=abc123";
      const result = makeResult();

      await saveHistory(url, result);

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining("data/history"),
        { recursive: true }
      );
    });
  });

  describe("getHistoryById", () => {
    it("returns the entry when file exists", async () => {
      const entry = {
        id: "h_1717232400000",
        url: "https://www.youtube.com/watch?v=abc",
        platform: "youtube",
        analyzedAt: "2025-06-01T10:00:00.000Z",
        result: makeResult(),
      };
      mockReadFile.mockResolvedValue(JSON.stringify(entry));

      const result = await getHistoryById("h_1717232400000");

      expect(result).toEqual(entry);
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining("h_1717232400000.json"),
        "utf-8"
      );
    });

    it("returns null when file does not exist", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

      const result = await getHistoryById("h_9999999999999");

      expect(result).toBeNull();
    });

    it("returns null for malformed JSON", async () => {
      mockReadFile.mockResolvedValue("not valid json {{{");

      const result = await getHistoryById("h_1717232400000");

      expect(result).toBeNull();
    });
  });

  describe("getHistory (alias)", () => {
    it("is the same function as getHistoryById", () => {
      expect(getHistory).toBe(getHistoryById);
    });
  });

  describe("deleteHistory", () => {
    it("returns true when file is successfully deleted", async () => {
      mockUnlink.mockResolvedValue(undefined);

      const result = await deleteHistory("h_1717232400000");

      expect(result).toBe(true);
      expect(mockUnlink).toHaveBeenCalledWith(
        expect.stringContaining("h_1717232400000.json")
      );
    });

    it("returns false when file does not exist", async () => {
      mockUnlink.mockRejectedValue(new Error("ENOENT: no such file"));

      const result = await deleteHistory("h_9999999999999");

      expect(result).toBe(false);
    });
  });

  describe("listHistory", () => {
    const entries = [
      {
        id: "h_1000",
        url: "https://www.youtube.com/watch?v=a",
        platform: "youtube",
        analyzedAt: "2025-01-01T10:00:00.000Z",
        result: makeResult(),
      },
      {
        id: "h_2000",
        url: "https://www.xiaohongshu.com/explore/b",
        platform: "xiaohongshu",
        analyzedAt: "2025-03-15T10:00:00.000Z",
        result: makeResult(),
      },
      {
        id: "h_3000",
        url: "https://www.youtube.com/watch?v=c",
        platform: "youtube",
        analyzedAt: "2025-06-01T10:00:00.000Z",
        result: makeResult(),
      },
    ];

    beforeEach(() => {
      mockReaddir.mockResolvedValue(["h_1000.json", "h_2000.json", "h_3000.json"]);
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("h_1000")) return Promise.resolve(JSON.stringify(entries[0]));
        if (filePath.includes("h_2000")) return Promise.resolve(JSON.stringify(entries[1]));
        if (filePath.includes("h_3000")) return Promise.resolve(JSON.stringify(entries[2]));
        return Promise.reject(new Error("ENOENT"));
      });
    });

    it("returns all entries sorted by date descending (most recent first)", async () => {
      const result = await listHistory();

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("h_3000");
      expect(result[1].id).toBe("h_2000");
      expect(result[2].id).toBe("h_1000");
    });

    it("filters by platform", async () => {
      const result = await listHistory({ platform: "youtube" });

      expect(result).toHaveLength(2);
      expect(result.every((e) => e.platform === "youtube")).toBe(true);
    });

    it("filters by platform - xiaohongshu", async () => {
      const result = await listHistory({ platform: "xiaohongshu" });

      expect(result).toHaveLength(1);
      expect(result[0].platform).toBe("xiaohongshu");
    });

    it("filters by startDate", async () => {
      const result = await listHistory({ startDate: "2025-03-01T00:00:00.000Z" });

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("h_3000");
      expect(result[1].id).toBe("h_2000");
    });

    it("filters by endDate", async () => {
      const result = await listHistory({ endDate: "2025-03-31T23:59:59.000Z" });

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("h_2000");
      expect(result[1].id).toBe("h_1000");
    });

    it("filters by date range (startDate + endDate)", async () => {
      const result = await listHistory({
        startDate: "2025-02-01T00:00:00.000Z",
        endDate: "2025-04-01T00:00:00.000Z",
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("h_2000");
    });

    it("combines platform and date filters", async () => {
      const result = await listHistory({
        platform: "youtube",
        startDate: "2025-05-01T00:00:00.000Z",
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("h_3000");
    });

    it("returns empty array when no entries match filters", async () => {
      const result = await listHistory({ platform: "xiaohongshu", startDate: "2026-01-01T00:00:00.000Z" });

      expect(result).toHaveLength(0);
    });

    it("returns empty array when directory read fails", async () => {
      mockReaddir.mockRejectedValue(new Error("ENOENT"));

      const result = await listHistory();

      expect(result).toHaveLength(0);
    });

    it("skips non-JSON files", async () => {
      mockReaddir.mockResolvedValue(["h_1000.json", "readme.txt", ".DS_Store"]);
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("h_1000")) return Promise.resolve(JSON.stringify(entries[0]));
        return Promise.reject(new Error("ENOENT"));
      });

      const result = await listHistory();

      expect(result).toHaveLength(1);
    });

    it("skips malformed JSON files gracefully", async () => {
      mockReaddir.mockResolvedValue(["h_1000.json", "h_bad.json"]);
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes("h_1000")) return Promise.resolve(JSON.stringify(entries[0]));
        if (filePath.includes("h_bad")) return Promise.resolve("not valid json");
        return Promise.reject(new Error("ENOENT"));
      });

      const result = await listHistory();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("h_1000");
    });
  });
});
