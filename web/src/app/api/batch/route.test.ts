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

vi.mock("child_process", () => ({
  spawn: mockSpawn,
  __esModule: true,
  default: { spawn: mockSpawn },
}));

// Mock fetch for auto-save to history
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
global.fetch = mockFetch as any;

import { POST } from "./route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readStream(response: Response): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    for (const line of text.split("\n")) {
      if (line.trim()) lines.push(line);
    }
  }
  return lines;
}

async function readStreamAsObjects(response: Response): Promise<Record<string, unknown>[]> {
  const lines = await readStream(response);
  return lines.map((line) => JSON.parse(line));
}

describe("POST /api/batch", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("URL validation", () => {
    it("rejects invalid JSON body", async () => {
      const req = new NextRequest("http://localhost:3000/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json{",
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid JSON");
    });

    it("rejects missing urls field", async () => {
      const res = await POST(makeRequest({}));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("non-empty array");
    });

    it("rejects empty urls array", async () => {
      const res = await POST(makeRequest({ urls: [] }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("non-empty array");
    });

    it("rejects non-array urls", async () => {
      const res = await POST(makeRequest({ urls: "https://example.com" }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("non-empty array");
    });

    it("rejects URLs without http/https protocol", async () => {
      const res = await POST(makeRequest({ urls: ["ftp://example.com/page"] }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid URL");
    });

    it("rejects empty string URLs", async () => {
      const res = await POST(makeRequest({ urls: [""] }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid URL");
    });

    it("rejects non-string URL entries", async () => {
      const res = await POST(makeRequest({ urls: [123] }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("must be a string");
    });

    it("accepts valid http URLs", async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from(JSON.stringify({ title: "Test" })));
          proc.emit("close", 0);
        });
        return proc;
      });

      const res = await POST(makeRequest({ urls: ["http://example.com/page"] }));
      expect(res.status).toBe(200);
    });

    it("accepts valid https URLs", async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from(JSON.stringify({ title: "Test" })));
          proc.emit("close", 0);
        });
        return proc;
      });

      const res = await POST(makeRequest({ urls: ["https://www.xiaohongshu.com/explore/abc"] }));
      expect(res.status).toBe(200);
    });
  });

  describe("max 20 URL limit", () => {
    it("rejects more than 20 URLs", async () => {
      const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/page${i}`);
      const res = await POST(makeRequest({ urls }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Maximum 20 URLs");
    });

    it("accepts exactly 20 URLs", async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from(JSON.stringify({ title: "Test" })));
          proc.emit("close", 0);
        });
        return proc;
      });

      const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/page${i}`);
      const res = await POST(makeRequest({ urls }));
      expect(res.status).toBe(200);
    });

    it("accepts fewer than 20 URLs", async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from(JSON.stringify({ title: "Test" })));
          proc.emit("close", 0);
        });
        return proc;
      });

      const res = await POST(makeRequest({ urls: ["https://example.com/a", "https://example.com/b"] }));
      expect(res.status).toBe(200);
    });
  });

  describe("concurrent processing limit (5)", () => {
    it("processes URLs in batches of 5", async () => {
      let concurrentCount = 0;
      let maxConcurrent = 0;

      mockSpawn.mockImplementation(() => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);

        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from(JSON.stringify({ title: "Result" })));
          proc.emit("close", 0);
          concurrentCount--;
        });
        return proc;
      });

      const urls = Array.from({ length: 7 }, (_, i) => `https://example.com/page${i}`);
      const res = await POST(makeRequest({ urls }));

      // Read the stream to completion
      await readStream(res);

      // Max concurrent should be 5 (first batch) not 7
      expect(maxConcurrent).toBeLessThanOrEqual(5);
      expect(mockSpawn).toHaveBeenCalledTimes(7);
    });

    it("spawns all URLs when count is within limit", async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from(JSON.stringify({ title: "Result" })));
          proc.emit("close", 0);
        });
        return proc;
      });

      const urls = Array.from({ length: 3 }, (_, i) => `https://example.com/page${i}`);
      const res = await POST(makeRequest({ urls }));
      await readStream(res);

      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    it("streams progress events for each URL", async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from(JSON.stringify({ title: "Result" })));
          proc.emit("close", 0);
        });
        return proc;
      });

      const res = await POST(makeRequest({ urls: ["https://example.com/a"] }));
      const events = await readStreamAsObjects(res);

      // Should have at least a "processing" event and a "done" event, plus summary
      const processingEvents = events.filter((e) => e.status === "processing");
      const doneEvents = events.filter((e) => e.status === "done");
      const summaryEvents = events.filter((e) => e.summary);

      expect(processingEvents.length).toBeGreaterThanOrEqual(1);
      expect(doneEvents).toHaveLength(1);
      expect(summaryEvents).toHaveLength(1);
    });
  });

  describe("partial failure handling", () => {
    it("continues processing remaining URLs when one fails", async () => {
      let callIndex = 0;
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        const idx = callIndex++;
        queueMicrotask(() => {
          if (idx === 1) {
            // Second URL fails
            proc.emit("close", 1);
          } else {
            // Others succeed
            proc.stdout.emit("data", Buffer.from(JSON.stringify({ title: `Result ${idx}` })));
            proc.emit("close", 0);
          }
        });
        return proc;
      });

      const urls = [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ];
      const res = await POST(makeRequest({ urls }));
      const events = await readStreamAsObjects(res);

      // All 3 URLs should be processed
      expect(mockSpawn).toHaveBeenCalledTimes(3);

      // Should have error for the failed one
      const errorEvents = events.filter((e) => e.status === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].url).toBe("https://example.com/b");

      // Should have done for the successful ones
      const doneEvents = events.filter((e) => e.status === "done");
      expect(doneEvents).toHaveLength(2);

      // Summary should reflect partial failure
      const summary = events.find((e) => e.summary) as any;
      expect(summary.summary.total).toBe(3);
      expect(summary.summary.success).toBe(2);
      expect(summary.summary.failed).toBe(1);
    });

    it("handles spawn error for a single URL without stopping batch", async () => {
      let callIndex = 0;
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        const idx = callIndex++;
        queueMicrotask(() => {
          if (idx === 0) {
            proc.emit("error", new Error("spawn ENOENT"));
          } else {
            proc.stdout.emit("data", Buffer.from(JSON.stringify({ title: "OK" })));
            proc.emit("close", 0);
          }
        });
        return proc;
      });

      const urls = ["https://example.com/a", "https://example.com/b"];
      const res = await POST(makeRequest({ urls }));
      const events = await readStreamAsObjects(res);

      const errorEvents = events.filter((e) => e.status === "error");
      const doneEvents = events.filter((e) => e.status === "done");

      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toContain("spawn ENOENT");
      expect(doneEvents).toHaveLength(1);

      const summary = events.find((e) => e.summary) as any;
      expect(summary.summary.success).toBe(1);
      expect(summary.summary.failed).toBe(1);
    });

    it("reports error when subprocess output is not valid JSON", async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from("not valid json"));
          proc.emit("close", 0);
        });
        return proc;
      });

      const res = await POST(makeRequest({ urls: ["https://example.com/a"] }));
      const events = await readStreamAsObjects(res);

      const errorEvents = events.filter((e) => e.status === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toContain("parse");

      const summary = events.find((e) => e.summary) as any;
      expect(summary.summary.failed).toBe(1);
    });

    it("emits summary with all failures when every URL fails", async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stderr.emit("data", Buffer.from("Error occurred\n"));
          proc.emit("close", 1);
        });
        return proc;
      });

      const urls = ["https://example.com/a", "https://example.com/b"];
      const res = await POST(makeRequest({ urls }));
      const events = await readStreamAsObjects(res);

      const summary = events.find((e) => e.summary) as any;
      expect(summary.summary.total).toBe(2);
      expect(summary.summary.success).toBe(0);
      expect(summary.summary.failed).toBe(2);
    });
  });
});
