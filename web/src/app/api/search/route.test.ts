import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { EventEmitter } from "events";

function createMockProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("child_process", () => {
  return {
    spawn: mockSpawn,
    __esModule: true,
    default: { spawn: mockSpawn },
  };
});

import { POST } from "./route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/search", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    const defaultProc = createMockProc();
    mockSpawn.mockReturnValue(defaultProc);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("request validation", () => {
    it("rejects invalid JSON body", async () => {
      const req = new NextRequest("http://localhost:3000/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json{",
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid JSON");
    });

    it("rejects missing keyword", async () => {
      const res = await POST(makeRequest({ platform: "xiaohongshu" }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("keyword");
    });

    it("rejects empty keyword", async () => {
      const res = await POST(makeRequest({ keyword: "   ", platform: "xiaohongshu" }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("empty");
    });

    it("rejects keyword exceeding max length", async () => {
      const longKeyword = "a".repeat(201);
      const res = await POST(makeRequest({ keyword: longKeyword, platform: "xiaohongshu" }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("too long");
    });

    it("rejects keyword with control characters", async () => {
      const res = await POST(makeRequest({ keyword: "test\x00keyword", platform: "xiaohongshu" }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("invalid characters");
    });

    it("rejects missing platform", async () => {
      const res = await POST(makeRequest({ keyword: "test" }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("platform");
    });

    it("rejects invalid platform value", async () => {
      const res = await POST(makeRequest({ keyword: "test", platform: "tiktok" }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid platform");
      expect(data.error).toContain("xiaohongshu");
      expect(data.error).toContain("youtube");
    });

    it("rejects invalid sort value", async () => {
      const res = await POST(
        makeRequest({ keyword: "test", platform: "xiaohongshu", sort: "random" })
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid sort");
    });

    it("rejects non-positive page number", async () => {
      const res = await POST(
        makeRequest({ keyword: "test", platform: "xiaohongshu", page: 0 })
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("page");
    });

    it("rejects non-integer page number", async () => {
      const res = await POST(
        makeRequest({ keyword: "test", platform: "xiaohongshu", page: 1.5 })
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("page");
    });
  });

  describe("timeout handling", () => {
    it("returns 504 when subprocess exceeds 15 seconds", async () => {
      vi.useFakeTimers();

      const proc = createMockProc();
      mockSpawn.mockReturnValue(proc);

      const resPromise = POST(
        makeRequest({ keyword: "slow search", platform: "xiaohongshu" })
      );

      // Flush microtasks so request.json() resolves and spawn is called
      await vi.advanceTimersByTimeAsync(0);

      // Advance timers to trigger the 15s timeout
      await vi.advanceTimersByTimeAsync(15_000);

      const res = await resPromise;
      expect(res.status).toBe(504);
      const data = await res.json();
      expect(data.error).toContain("timed out");
      expect(data.error).toContain("15 seconds");
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  describe("subprocess success", () => {
    it("returns parsed JSON from successful subprocess", async () => {
      const mockResult = {
        keyword: "test",
        platform: "xiaohongshu",
        total: 1,
        items: [{ note_id: "abc", title: "Test", url: "https://example.com", author: "Author", likes: 100, content_type: "normal" }],
        warnings: [],
      };

      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from(JSON.stringify(mockResult)));
          proc.emit("close", 0);
        });
        return proc;
      });

      const res = await POST(
        makeRequest({ keyword: "test", platform: "xiaohongshu" })
      );

      expect(mockSpawn).toHaveBeenCalled();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.keyword).toBe("test");
      expect(data.total).toBe(1);
      expect(data.items).toHaveLength(1);
    });
  });

  describe("subprocess error", () => {
    it("returns 500 when subprocess exits with non-zero code", async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stderr.emit("data", Buffer.from("ModuleNotFoundError: No module named 'content_analyzer'\n"));
          proc.emit("close", 1);
        });
        return proc;
      });

      const res = await POST(
        makeRequest({ keyword: "test", platform: "youtube" })
      );

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("ModuleNotFoundError");
    });

    it("returns 500 when spawn itself errors", async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.emit("error", new Error("spawn ENOENT"));
        });
        return proc;
      });

      const res = await POST(
        makeRequest({ keyword: "test", platform: "xiaohongshu" })
      );

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("spawn ENOENT");
    });
  });
});
