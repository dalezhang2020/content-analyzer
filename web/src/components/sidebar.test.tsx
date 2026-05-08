import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Sidebar } from "./sidebar";

// Mock next/navigation
const mockPathname = vi.fn(() => "/");
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));

// Mock next/link to render a plain anchor
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("Sidebar", () => {
  beforeEach(() => {
    mockPathname.mockReturnValue("/");
  });

  describe("active link highlighting", () => {
    it("highlights Dashboard link when on root path", () => {
      mockPathname.mockReturnValue("/");
      render(<Sidebar />);

      const dashboardLink = screen.getByRole("link", { name: /Dashboard/i });
      expect(dashboardLink).toHaveAttribute("aria-current", "page");
      expect(dashboardLink.className).toContain("amber");
    });

    it("highlights Search link when on /search path", () => {
      mockPathname.mockReturnValue("/search");
      render(<Sidebar />);

      const searchLink = screen.getByRole("link", { name: /Search/i });
      expect(searchLink).toHaveAttribute("aria-current", "page");
      expect(searchLink.className).toContain("amber");

      // Dashboard should NOT be active
      const dashboardLink = screen.getByRole("link", { name: /Dashboard/i });
      expect(dashboardLink).not.toHaveAttribute("aria-current");
    });

    it("highlights Analyze link when on /analyze subpath", () => {
      mockPathname.mockReturnValue("/analyze?url=https://example.com");
      render(<Sidebar />);

      const analyzeLink = screen.getByRole("link", { name: /Analyze/i });
      expect(analyzeLink).toHaveAttribute("aria-current", "page");
    });

    it("highlights History link when on /history/[id] subpath", () => {
      mockPathname.mockReturnValue("/history/h_123456");
      render(<Sidebar />);

      const historyLink = screen.getByRole("link", { name: /History/i });
      expect(historyLink).toHaveAttribute("aria-current", "page");
    });

    it("does not highlight Dashboard for non-root paths starting with /", () => {
      mockPathname.mockReturnValue("/plans");
      render(<Sidebar />);

      const dashboardLink = screen.getByRole("link", { name: /Dashboard/i });
      expect(dashboardLink).not.toHaveAttribute("aria-current");

      const plansLink = screen.getByRole("link", { name: /Plans/i });
      expect(plansLink).toHaveAttribute("aria-current", "page");
    });
  });

  describe("responsive collapse behavior", () => {
    it("renders a mobile toggle button", () => {
      render(<Sidebar />);

      const toggleButton = screen.getByLabelText(/close sidebar/i);
      expect(toggleButton).toBeInTheDocument();
    });

    it("toggles sidebar visibility when mobile button is clicked", () => {
      render(<Sidebar />);

      const sidebar = screen.getByRole("navigation", {
        name: /main navigation/i,
      }).closest("aside")!;

      // Initially open (data-open=true)
      expect(sidebar).toHaveAttribute("data-open", "true");

      // Click toggle to collapse
      const toggleButton = screen.getByLabelText(/close sidebar/i);
      fireEvent.click(toggleButton);

      // After click, sidebar should be collapsed (data-open=false)
      expect(sidebar).toHaveAttribute("data-open", "false");
    });

    it("toggle button label changes based on collapsed state", () => {
      render(<Sidebar />);

      // Initially shows "Close sidebar"
      expect(screen.getByLabelText(/close sidebar/i)).toBeInTheDocument();

      // Click to collapse
      fireEvent.click(screen.getByLabelText(/close sidebar/i));

      // Now shows "Open sidebar"
      expect(screen.getByLabelText(/open sidebar/i)).toBeInTheDocument();
    });

    it("sidebar has correct width class", () => {
      render(<Sidebar />);

      const sidebar = screen.getByRole("navigation", {
        name: /main navigation/i,
      }).closest("aside")!;

      expect(sidebar.className).toContain("w-[200px]");
    });

    it("applies translate class when collapsed", () => {
      render(<Sidebar />);

      const sidebar = screen.getByRole("navigation", {
        name: /main navigation/i,
      }).closest("aside")!;

      // Click to collapse
      fireEvent.click(screen.getByLabelText(/close sidebar/i));

      // Should have the translate class for hiding
      expect(sidebar.className).toContain("-translate-x-full");
    });
  });
});
