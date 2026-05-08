"use client";

import { useState, useEffect, useRef } from "react";
import { Search, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SearchResponse } from "@/lib/types";

export type Platform = "xiaohongshu" | "youtube";
export type SortOption = "general" | "popular" | "latest";

export interface SearchPanelProps {
  onResults: (data: SearchResponse) => void;
  onError?: (error: string) => void;
  initialKeyword?: string;
  initialPlatform?: Platform;
  initialSort?: SortOption;
  onStateChange?: (state: { keyword: string; platform: Platform; sort: SortOption }) => void;
}

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "general", label: "综合" },
  { value: "popular", label: "最热" },
  { value: "latest", label: "最新" },
];

export function SearchPanel({ onResults, onError, initialKeyword, initialPlatform, initialSort, onStateChange }: SearchPanelProps) {
  const [keyword, setKeyword] = useState(initialKeyword || "");
  const [platform, setPlatform] = useState<Platform>(initialPlatform || "xiaohongshu");
  const [sort, setSort] = useState<SortOption>(initialSort || "general");
  const [isLoading, setIsLoading] = useState(false);

  // Notify parent of state changes for URL sync
  useEffect(() => {
    onStateChange?.({ keyword, platform, sort });
  }, [keyword, platform, sort, onStateChange]);

  // Auto-trigger search if initial keyword is provided
  const autoSearchedRef = useRef(false);
  useEffect(() => {
    if (initialKeyword && !autoSearchedRef.current) {
      autoSearchedRef.current = true;
      // Trigger search after mount
      const timer = setTimeout(() => {
        handleSearchInternal();
      }, 100);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearchInternal = async () => {
    const trimmed = keyword.trim();
    if (!trimmed) return;

    setIsLoading(true);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: trimmed,
          platform,
          sort,
          page: 1,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        const errorMsg = data.error || `Search failed (${res.status})`;
        onError?.(errorMsg);
        return;
      }

      onResults(data as SearchResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      onError?.(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = async () => {
    await handleSearchInternal();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isLoading) {
      handleSearch();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Keyword input + search button */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="搜索关键词..."
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          className="flex-1"
        />
        <Button
          onClick={handleSearch}
          disabled={isLoading || !keyword.trim()}
          size="default"
        >
          <Search className="size-4" />
          搜索
        </Button>
      </div>

      {/* Platform selector + sort dropdown */}
      <div className="flex items-center gap-3">
        {/* Platform toggle buttons */}
        <div className="flex items-center gap-1">
          <Button
            variant={platform === "xiaohongshu" ? "default" : "outline"}
            size="sm"
            onClick={() => setPlatform("xiaohongshu")}
            disabled={isLoading}
          >
            小红书
          </Button>
          <Button
            variant={platform === "youtube" ? "default" : "outline"}
            size="sm"
            onClick={() => setPlatform("youtube")}
            disabled={isLoading}
          >
            YouTube
          </Button>
        </div>

        {/* Sort dropdown */}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortOption)}
          disabled={isLoading}
          className={cn(
            "h-7 rounded-md border border-input bg-background px-2 text-sm",
            "focus:outline-none focus:ring-2 focus:ring-ring/50",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
          aria-label="排序方式"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Loading indicator */}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="size-4 animate-spin" />
          <span>正在搜索 &apos;{keyword.trim()}&apos;...</span>
        </div>
      )}
    </div>
  );
}
