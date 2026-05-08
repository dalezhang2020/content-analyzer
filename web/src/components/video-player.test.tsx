import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { VideoPlayer } from "./video-player";

describe("VideoPlayer", () => {
  const defaultSrc = "/videos/video-1717232400000.mp4";

  describe("rendering", () => {
    it("renders a video element with the provided src", () => {
      render(<VideoPlayer src={defaultSrc} />);

      const video = document.querySelector("video");
      expect(video).not.toBeNull();
      expect(video?.getAttribute("src")).toBe(defaultSrc);
    });

    it("renders native controls on the video element", () => {
      render(<VideoPlayer src={defaultSrc} />);

      const video = document.querySelector("video");
      expect(video?.hasAttribute("controls")).toBe(true);
    });

    it("displays the filename extracted from the src path", () => {
      render(<VideoPlayer src={defaultSrc} />);

      expect(screen.getByText("video-1717232400000.mp4")).toBeInTheDocument();
    });

    it("renders a download link with correct href and download attribute", () => {
      render(<VideoPlayer src={defaultSrc} />);

      const downloadLink = screen.getByText("Download").closest("a");
      expect(downloadLink).not.toBeNull();
      expect(downloadLink?.getAttribute("href")).toBe(defaultSrc);
      expect(downloadLink?.getAttribute("download")).toBe("video-1717232400000.mp4");
    });
  });

  describe("autoPlay", () => {
    beforeEach(() => {
      // jsdom doesn't implement play(), so we mock it
      HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("attempts to play the video when autoPlay is true (default)", () => {
      render(<VideoPlayer src={defaultSrc} />);

      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    });

    it("does not attempt to play when autoPlay is false", () => {
      render(<VideoPlayer src={defaultSrc} autoPlay={false} />);

      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    });
  });

  describe("onEnded callback", () => {
    it("calls onEnded when the video ends", () => {
      const onEnded = vi.fn();
      render(<VideoPlayer src={defaultSrc} onEnded={onEnded} />);

      const video = document.querySelector("video")!;
      fireEvent.ended(video);

      expect(onEnded).toHaveBeenCalledTimes(1);
    });

    it("does not throw when onEnded is not provided", () => {
      render(<VideoPlayer src={defaultSrc} />);

      const video = document.querySelector("video")!;
      expect(() => fireEvent.ended(video)).not.toThrow();
    });
  });

  describe("responsive layout", () => {
    it("renders with 16:9 aspect ratio container", () => {
      render(<VideoPlayer src={defaultSrc} />);

      const container = document.querySelector("[style*='aspect-ratio']");
      expect(container).not.toBeNull();
      expect(container?.getAttribute("style")).toContain("16 / 9");
    });
  });
});
