import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionPanel } from "./action-panel";
import type { AnalysisResult } from "@/lib/types";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const mockResult: AnalysisResult = {
  metadata: {
    video_id: "test-123",
    title: "Test Video",
    channel: "Test Channel",
    publish_date: "2025-01-01",
    duration_seconds: 300,
    view_count: 1000,
  },
  transcript: null,
  comments: null,
  image_analysis: null,
  hook: "Did you know this one trick?",
  structure: ["Point 1", "Point 2", "Point 3"],
  takeaways: ["Takeaway 1", "Takeaway 2"],
  reusable_angles: ["Angle 1", "Angle 2"],
  keywords: ["AI", "coding", "productivity"],
  content_style: "tutorial",
  audience_intent: "learn",
  engagement_hooks: ["Hook 1"],
  cta_signals: ["Subscribe"],
  adaptation_ideas: ["Idea 1"],
  warnings: [],
};

function navigateToVideoTab() {
  const videoTab = screen.getByText("🎬 Video");
  fireEvent.click(videoTab);
}

describe("ActionPanel - Video Enhancement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Error/Retry flow (Req 3.4)", () => {
    it("displays error message when video generation fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          json: async () => ({ error: "Render process crashed" }),
        })
      );

      render(<ActionPanel result={mockResult} />);
      navigateToVideoTab();

      const generateBtn = screen.getByText("Generate Video");
      fireEvent.click(generateBtn);

      await waitFor(() => {
        expect(screen.getByText("Render process crashed")).toBeInTheDocument();
      });
    });

    it("displays error when fetch throws a network error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network failure"))
      );

      render(<ActionPanel result={mockResult} />);
      navigateToVideoTab();

      const generateBtn = screen.getByText("Generate Video");
      fireEvent.click(generateBtn);

      await waitFor(() => {
        expect(screen.getByText("Network failure")).toBeInTheDocument();
      });
    });

    it("shows Retry button after error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          json: async () => ({ error: "Server error" }),
        })
      );

      render(<ActionPanel result={mockResult} />);
      navigateToVideoTab();

      const generateBtn = screen.getByText("Generate Video");
      fireEvent.click(generateBtn);

      await waitFor(() => {
        expect(screen.getByText("Server error")).toBeInTheDocument();
      });

      // Retry button should be available
      expect(screen.getByText("Retry")).toBeInTheDocument();
      // Generate Video button should be hidden when error is shown
      expect(screen.queryByText("Generate Video")).not.toBeInTheDocument();
    });

    it("retries successfully after a previous failure", async () => {
      const fetchMock = vi
        .fn()
        // First call fails
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({ error: "Temporary failure" }),
        })
        // Second call succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ url: "/videos/video-retry.mp4" }),
        });

      vi.stubGlobal("fetch", fetchMock);

      render(<ActionPanel result={mockResult} />);
      navigateToVideoTab();

      // First attempt - fails
      const generateBtn = screen.getByText("Generate Video");
      fireEvent.click(generateBtn);

      await waitFor(() => {
        expect(screen.getByText("Temporary failure")).toBeInTheDocument();
      });

      // Retry - succeeds
      const retryBtn = screen.getByText("Retry");
      fireEvent.click(retryBtn);

      await waitFor(() => {
        // VideoPlayer renders with the video element
        const video = document.querySelector("video");
        expect(video).not.toBeNull();
        expect(video?.getAttribute("src")).toBe("/videos/video-retry.mp4");
      });
    });
  });

  describe("Timeout enforcement (Req 3.5)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("aborts video generation after 120 seconds", async () => {
      // Create a fetch that never resolves but respects abort signal
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((_url: string, options?: RequestInit) => {
          return new Promise((_resolve, reject) => {
            if (options?.signal) {
              options.signal.addEventListener("abort", () => {
                reject(
                  new DOMException("The operation was aborted.", "AbortError")
                );
              });
            }
          });
        })
      );

      render(<ActionPanel result={mockResult} />);
      navigateToVideoTab();

      const generateBtn = screen.getByText("Generate Video");
      await act(async () => {
        fireEvent.click(generateBtn);
      });

      // Should be loading
      expect(screen.getByText("Rendering video…")).toBeInTheDocument();

      // Advance past the 120s timeout
      await act(async () => {
        vi.advanceTimersByTime(120_000);
      });

      // Should show user-friendly timeout error message
      expect(
        screen.getByText(
          "Video generation timed out (120s limit). Try again or use a shorter analysis."
        )
      ).toBeInTheDocument();

      // Retry button should be available
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });
  });

  describe("VideoProgress → VideoPlayer transition (Req 3.2)", () => {
    it("shows progress indicator while video is loading", async () => {
      // Fetch that stays pending
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(
          () => new Promise(() => {}) // Never resolves
        )
      );

      render(<ActionPanel result={mockResult} />);
      navigateToVideoTab();

      const generateBtn = screen.getByText("Generate Video");
      fireEvent.click(generateBtn);

      // Button text changes to loading state
      expect(screen.getByText("Rendering video…")).toBeInTheDocument();
    });

    it("shows VideoPlayer after successful generation", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ url: "/videos/video-success.mp4" }),
        })
      );

      render(<ActionPanel result={mockResult} />);
      navigateToVideoTab();

      const generateBtn = screen.getByText("Generate Video");
      fireEvent.click(generateBtn);

      await waitFor(() => {
        // VideoPlayer renders with the video element
        const video = document.querySelector("video");
        expect(video).not.toBeNull();
        expect(video?.getAttribute("src")).toBe("/videos/video-success.mp4");
      });

      // Download link from VideoPlayer should be present
      expect(screen.getByText("Download")).toBeInTheDocument();
    });

    it("replaces Generate Video button with Regenerate once video is ready", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ url: "/videos/video-done.mp4" }),
        })
      );

      render(<ActionPanel result={mockResult} />);
      navigateToVideoTab();

      const generateBtn = screen.getByText("Generate Video");
      fireEvent.click(generateBtn);

      await waitFor(() => {
        expect(screen.getByText("Regenerate")).toBeInTheDocument();
      });

      // Original "Generate Video" button should be gone
      expect(screen.queryByText("Generate Video")).not.toBeInTheDocument();
    });
  });
});
