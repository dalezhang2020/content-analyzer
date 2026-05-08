import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VideoProgress } from "./video-progress";

describe("VideoProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when not loading and no progress", () => {
    const { container } = render(<VideoProgress isLoading={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows progress bar when loading starts", () => {
    render(<VideoProgress isLoading={true} />);
    // Should show the stage text
    expect(screen.getByText("Generating composition…")).toBeInTheDocument();
    // Should show 0% initially
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("shows elapsed time that increments", () => {
    render(<VideoProgress isLoading={true} />);
    expect(screen.getByText("0s elapsed")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText("3s elapsed")).toBeInTheDocument();
  });

  it("shows estimated remaining time", () => {
    render(<VideoProgress isLoading={true} />);
    // Initially ~30s remaining
    expect(screen.getByText("~30s remaining")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(screen.getByText("~20s remaining")).toBeInTheDocument();
  });

  it("advances through stages as progress increases", () => {
    render(<VideoProgress isLoading={true} />);

    // Initially in "Generating composition…" stage (0-30%)
    expect(screen.getByText("Generating composition…")).toBeInTheDocument();

    // Advance to ~50% of estimated time → should be in "Rendering video…" stage
    act(() => {
      vi.advanceTimersByTime(15000);
    });

    expect(screen.getByText("Rendering video…")).toBeInTheDocument();
  });

  it("holds near 90% when exceeding estimated duration", () => {
    render(<VideoProgress isLoading={true} />);

    // Advance past the 30s estimated duration
    act(() => {
      vi.advanceTimersByTime(35000);
    });

    // Should show "Almost done…" instead of remaining time
    expect(screen.getByText("Almost done…")).toBeInTheDocument();
  });

  it("jumps to 100% and shows complete when loading finishes", () => {
    const { rerender } = render(<VideoProgress isLoading={true} />);

    // Advance some time
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Stop loading
    rerender(<VideoProgress isLoading={false} />);

    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("✓ Complete")).toBeInTheDocument();
  });

  it("calls onComplete when loading finishes", () => {
    const onComplete = vi.fn();
    const { rerender } = render(
      <VideoProgress isLoading={true} onComplete={onComplete} />
    );

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    rerender(<VideoProgress isLoading={false} onComplete={onComplete} />);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("does not show remaining time after completion", () => {
    const { rerender } = render(<VideoProgress isLoading={true} />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    rerender(<VideoProgress isLoading={false} />);

    expect(screen.queryByText(/remaining/)).not.toBeInTheDocument();
    expect(screen.queryByText(/elapsed/)).not.toBeInTheDocument();
  });
});
