"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Search,
  FileText,
  History,
  ClipboardList,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect, useCallback } from "react";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/search", label: "Search", icon: Search },
  { href: "/analyze", label: "Analyze", icon: FileText },
  { href: "/history", label: "History", icon: History },
  { href: "/plans", label: "Plans", icon: ClipboardList },
];

interface AdapterStatus {
  name: string;
  ok: boolean;
}

const defaultAdapterStatuses: AdapterStatus[] = [
  { name: "YouTube", ok: true },
  { name: "Xiaohongshu", ok: true },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [adapterStatuses, setAdapterStatuses] = useState<AdapterStatus[]>(defaultAdapterStatuses);

  const fetchAdapterHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok) return;
      const data = await res.json();
      if (data.adapterHealth) {
        setAdapterStatuses([
          { name: "YouTube", ok: data.adapterHealth.youtube?.ok ?? true },
          { name: "Xiaohongshu", ok: data.adapterHealth.xiaohongshu?.ok ?? true },
        ]);
      }
    } catch {
      // Silently fail — keep showing default/last known status
    }
  }, []);

  useEffect(() => {
    fetchAdapterHealth();
    const interval = setInterval(fetchAdapterHealth, 60_000);
    return () => clearInterval(interval);
  }, [fetchAdapterHealth]);

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  return (
    <>
      {/* Mobile overlay toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="fixed top-3 left-3 z-50 lg:hidden p-2 rounded-md bg-background border border-border"
        aria-label={collapsed ? "Open sidebar" : "Close sidebar"}
      >
        {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
      </button>

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-sidebar transition-transform duration-200",
          "w-[200px]",
          // On smaller screens (< 1024px), collapse off-screen unless toggled
          collapsed ? "-translate-x-full lg:translate-x-0" : "translate-x-0",
          // Default hidden on mobile, visible on desktop
          "max-lg:-translate-x-full max-lg:data-[open=true]:translate-x-0"
        )}
        data-open={!collapsed}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-4 border-b border-border">
          <div className="size-6 rounded bg-amber-600 flex items-center justify-center">
            <FileText className="size-3.5 text-white" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Content Analyzer</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-2 py-3 space-y-0.5" aria-label="Main navigation">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  active
                    ? "bg-amber-600/10 text-amber-700 border border-amber-600/20"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                )}
                aria-current={active ? "page" : undefined}
              >
                <item.icon className={cn("size-4", active && "text-amber-600")} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Adapter health status */}
        <div className="px-3 py-3 border-t border-border">
          <p className="text-xs font-medium text-muted-foreground mb-2">Adapters</p>
          <div className="space-y-1.5">
            {adapterStatuses.map((adapter) => (
              <div key={adapter.name} className="flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    adapter.ok ? "bg-emerald-500" : "bg-red-500"
                  )}
                  aria-label={adapter.ok ? "healthy" : "unhealthy"}
                />
                <span className="text-sidebar-foreground">{adapter.name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Collapse toggle (desktop) */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="hidden lg:flex items-center justify-center py-2 border-t border-border text-muted-foreground hover:text-foreground transition-colors"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <PanelLeftClose className="size-4" />
        </button>
      </aside>
    </>
  );
}
