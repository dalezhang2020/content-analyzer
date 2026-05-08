import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BatchInput } from "./batch-input";

describe("BatchInput", () => {
  const mockOnSubmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("URL validation", () => {
    it("shows valid count for http/https URLs", () => {
      render(<BatchInput onSubmit={mockOnSubmit} />);

      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, {
        target: { value: "https://example.com\nhttp://test.com" },
      });

      expect(screen.getByText(/2 valid URLs/)).toBeInTheDocument();
    });

    it("does not count invalid URLs (no protocol)", () => {
      render(<BatchInput onSubmit={mockOnSubmit} />);

      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, {
        target: { value: "https://example.com\nexample.com\nftp://bad.com" },
      });

      expect(screen.getByText(/1 valid URL/)).toBeInTheDocument();
    });

    it("handles comma-separated URLs", () => {
      render(<BatchInput onSubmit={mockOnSubmit} />);

      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, {
        target: { value: "https://a.com, https://b.com, https://c.com" },
      });

      expect(screen.getByText(/3 valid URLs/)).toBeInTheDocument();
    });

    it("only submits valid URLs", () => {
      render(<BatchInput onSubmit={mockOnSubmit} />);

      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, {
        target: { value: "https://good.com\nbad-url\nhttps://also-good.com" },
      });

      fireEvent.click(screen.getByRole("button", { name: /Analyze/i }));

      expect(mockOnSubmit).toHaveBeenCalledWith([
        "https://good.com",
        "https://also-good.com",
      ]);
    });
  });

  describe("max 20 URL limit", () => {
    it("shows max 20 warning when too many URLs entered", () => {
      render(<BatchInput onSubmit={mockOnSubmit} />);

      const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/page${i}`).join("\n");
      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, { target: { value: urls } });

      expect(screen.getByText(/max 20/)).toBeInTheDocument();
    });

    it("disables submit button when more than 20 URLs", () => {
      render(<BatchInput onSubmit={mockOnSubmit} />);

      const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/page${i}`).join("\n");
      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, { target: { value: urls } });

      const button = screen.getByRole("button", { name: /Analyze/i });
      expect(button).toBeDisabled();
    });

    it("enables submit button with exactly 20 URLs", () => {
      render(<BatchInput onSubmit={mockOnSubmit} />);

      const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/page${i}`).join("\n");
      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, { target: { value: urls } });

      const button = screen.getByRole("button", { name: /Analyze/i });
      expect(button).not.toBeDisabled();
    });
  });

  describe("submit button state", () => {
    it("disables submit button when no URLs entered", () => {
      render(<BatchInput onSubmit={mockOnSubmit} />);

      const button = screen.getByRole("button", { name: /Analyze/i });
      expect(button).toBeDisabled();
    });

    it("disables submit button when only invalid URLs entered", () => {
      render(<BatchInput onSubmit={mockOnSubmit} />);

      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "not-a-url\nalso-not-valid" } });

      const button = screen.getByRole("button", { name: /Analyze/i });
      expect(button).toBeDisabled();
    });

    it("disables textarea and button when disabled prop is true", () => {
      render(<BatchInput onSubmit={mockOnSubmit} disabled />);

      const textarea = screen.getByRole("textbox");
      expect(textarea).toBeDisabled();
    });

    it("shows 'No URLs entered' when textarea is empty", () => {
      render(<BatchInput onSubmit={mockOnSubmit} />);
      expect(screen.getByText("No URLs entered")).toBeInTheDocument();
    });
  });
});
