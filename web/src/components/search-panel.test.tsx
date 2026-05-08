import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SearchPanel } from "./search-panel";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("SearchPanel", () => {
  const mockOnResults = vi.fn();
  const mockOnError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("rendering", () => {
    it("renders keyword input, platform buttons, and sort dropdown", () => {
      render(<SearchPanel onResults={mockOnResults} />);

      expect(screen.getByPlaceholderText("搜索关键词...")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /小红书/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /YouTube/i })).toBeInTheDocument();
      expect(screen.getByLabelText("排序方式")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /搜索/i })).toBeInTheDocument();
    });

    it("search button is disabled when keyword is empty", () => {
      render(<SearchPanel onResults={mockOnResults} />);

      const searchBtn = screen.getByRole("button", { name: /搜索/i });
      expect(searchBtn).toBeDisabled();
    });
  });

  describe("loading indicator", () => {
    it("shows loading indicator with keyword during search", async () => {
      // Mock a fetch that never resolves (to keep loading state)
      mockFetch.mockReturnValue(new Promise(() => {}));

      render(<SearchPanel onResults={mockOnResults} onError={mockOnError} />);

      const input = screen.getByPlaceholderText("搜索关键词...");
      fireEvent.change(input, { target: { value: "AI编程" } });
      fireEvent.click(screen.getByRole("button", { name: /搜索/i }));

      // Loading indicator should appear with the keyword
      await waitFor(() => {
        expect(screen.getByText(/正在搜索/)).toBeInTheDocument();
        expect(screen.getByText(/AI编程/)).toBeInTheDocument();
      });
    });

    it("hides loading indicator after search completes", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          keyword: "test",
          platform: "xiaohongshu",
          total: 0,
          items: [],
          warnings: [],
        }),
      });

      render(<SearchPanel onResults={mockOnResults} onError={mockOnError} />);

      const input = screen.getByPlaceholderText("搜索关键词...");
      fireEvent.change(input, { target: { value: "test" } });
      fireEvent.click(screen.getByRole("button", { name: /搜索/i }));

      await waitFor(() => {
        expect(screen.queryByText(/正在搜索/)).not.toBeInTheDocument();
      });
    });

    it("disables inputs during loading", async () => {
      mockFetch.mockReturnValue(new Promise(() => {}));

      render(<SearchPanel onResults={mockOnResults} onError={mockOnError} />);

      const input = screen.getByPlaceholderText("搜索关键词...");
      fireEvent.change(input, { target: { value: "test" } });
      fireEvent.click(screen.getByRole("button", { name: /搜索/i }));

      await waitFor(() => {
        expect(input).toBeDisabled();
        expect(screen.getByRole("button", { name: /小红书/i })).toBeDisabled();
        expect(screen.getByRole("button", { name: /YouTube/i })).toBeDisabled();
        expect(screen.getByLabelText("排序方式")).toBeDisabled();
      });
    });
  });

  describe("search request", () => {
    it("sends correct request body with default sort and page", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          keyword: "test",
          platform: "xiaohongshu",
          total: 0,
          items: [],
          warnings: [],
        }),
      });

      render(<SearchPanel onResults={mockOnResults} />);

      const input = screen.getByPlaceholderText("搜索关键词...");
      fireEvent.change(input, { target: { value: "test" } });
      fireEvent.click(screen.getByRole("button", { name: /搜索/i }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keyword: "test",
            platform: "xiaohongshu",
            sort: "general",
            page: 1,
          }),
        });
      });
    });

    it("sends selected platform in request", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          keyword: "test",
          platform: "youtube",
          total: 0,
          items: [],
          warnings: [],
        }),
      });

      render(<SearchPanel onResults={mockOnResults} />);

      // Switch to YouTube
      fireEvent.click(screen.getByRole("button", { name: /YouTube/i }));

      const input = screen.getByPlaceholderText("搜索关键词...");
      fireEvent.change(input, { target: { value: "test" } });
      fireEvent.click(screen.getByRole("button", { name: /搜索/i }));

      await waitFor(() => {
        const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(callBody.platform).toBe("youtube");
      });
    });

    it("triggers search on Enter key press", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          keyword: "enter test",
          platform: "xiaohongshu",
          total: 0,
          items: [],
          warnings: [],
        }),
      });

      render(<SearchPanel onResults={mockOnResults} />);

      const input = screen.getByPlaceholderText("搜索关键词...");
      fireEvent.change(input, { target: { value: "enter test" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
    });

    it("does not trigger search when keyword is empty", () => {
      render(<SearchPanel onResults={mockOnResults} />);

      const input = screen.getByPlaceholderText("搜索关键词...");
      fireEvent.keyDown(input, { key: "Enter" });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("calls onError when API returns non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "keyword is required and must be a string" }),
      });

      render(<SearchPanel onResults={mockOnResults} onError={mockOnError} />);

      const input = screen.getByPlaceholderText("搜索关键词...");
      fireEvent.change(input, { target: { value: "test" } });
      fireEvent.click(screen.getByRole("button", { name: /搜索/i }));

      await waitFor(() => {
        expect(mockOnError).toHaveBeenCalledWith("keyword is required and must be a string");
      });
    });

    it("calls onError with platform-not-supported message", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "Platform does not support search" }),
      });

      render(<SearchPanel onResults={mockOnResults} onError={mockOnError} />);

      const input = screen.getByPlaceholderText("搜索关键词...");
      fireEvent.change(input, { target: { value: "test" } });
      fireEvent.click(screen.getByRole("button", { name: /搜索/i }));

      await waitFor(() => {
        expect(mockOnError).toHaveBeenCalledWith("Platform does not support search");
      });
    });

    it("calls onError on network failure", async () => {
      mockFetch.mockRejectedValue(new Error("Failed to fetch"));

      render(<SearchPanel onResults={mockOnResults} onError={mockOnError} />);

      const input = screen.getByPlaceholderText("搜索关键词...");
      fireEvent.change(input, { target: { value: "test" } });
      fireEvent.click(screen.getByRole("button", { name: /搜索/i }));

      await waitFor(() => {
        expect(mockOnError).toHaveBeenCalledWith("Failed to fetch");
      });
    });

    it("calls onResults on successful search", async () => {
      const mockResponse = {
        keyword: "AI",
        platform: "xiaohongshu",
        total: 1,
        items: [
          {
            note_id: "abc123",
            title: "AI工具推荐",
            url: "https://www.xiaohongshu.com/explore/abc123",
            author: "创作者",
            likes: 5200,
            content_type: "normal",
          },
        ],
        warnings: [],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<SearchPanel onResults={mockOnResults} onError={mockOnError} />);

      const input = screen.getByPlaceholderText("搜索关键词...");
      fireEvent.change(input, { target: { value: "AI" } });
      fireEvent.click(screen.getByRole("button", { name: /搜索/i }));

      await waitFor(() => {
        expect(mockOnResults).toHaveBeenCalledWith(mockResponse);
        expect(mockOnError).not.toHaveBeenCalled();
      });
    });
  });
});
