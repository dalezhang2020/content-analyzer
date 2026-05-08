"use client";

import { useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SearchPanel } from "@/components/search-panel";
import { AnalysisCard } from "@/components/analysis-card";
import { AlertTriangle } from "lucide-react";
import type { SearchResponse, SearchResultItem } from "@/lib/types";
import type { Platform, SortOption } from "@/components/search-panel";

function SearchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Read initial state from URL query params
  const initialKeyword = searchParams.get("q") || "";
  const initialPlatform = (searchParams.get("platform") as Platform) || "xiaohongshu";
  const initialSort = (searchParams.get("sort") as SortOption) || "general";

  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>(initialPlatform);

  const handleResults = (data: SearchResponse) => {
    setResults(data.items);
    setWarnings(data.warnings || []);
    setPlatform(data.platform);
    setError(null);
    setHasSearched(true);
  };

  const handleError = (errorMsg: string) => {
    setError(errorMsg);
    setResults([]);
    setWarnings([]);
    setHasSearched(true);
  };

  const handleCardClick = (item: SearchResultItem) => {
    window.location.href = `/analyze?url=${encodeURIComponent(item.url)}`;
  };

  // Sync search state to URL query params
  const handleStateChange = useCallback(
    (state: { keyword: string; platform: Platform; sort: SortOption }) => {
      const params = new URLSearchParams();
      if (state.keyword) params.set("q", state.keyword);
      if (state.platform !== "xiaohongshu") params.set("platform", state.platform);
      if (state.sort !== "general") params.set("sort", state.sort);

      const paramString = params.toString();
      const newUrl = paramString ? `/search?${paramString}` : "/search";
      router.replace(newUrl, { scroll: false });
    },
    [router]
  );

  // Check if error indicates search is unavailable for the platform
  const isSearchUnavailable =
    error?.toLowerCase().includes("not support") ||
    error?.toLowerCase().includes("unavailable") ||
    error?.toLowerCase().includes("不支持");

  return (
    <main className="flex-1 flex flex-col px-6 py-12">
      <div className="w-full max-w-4xl space-y-6">
        {/* Header */}
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
          <p className="text-sm text-muted-foreground">
            Search keywords across YouTube and Xiaohongshu to discover trending content.
          </p>
        </header>

        {/* Search Panel */}
        <SearchPanel
          onResults={handleResults}
          onError={handleError}
          initialKeyword={initialKeyword}
          initialPlatform={initialPlatform}
          initialSort={initialSort}
          onStateChange={handleStateChange}
        />

        {/* Error state */}
        {error && (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
            <AlertTriangle className="size-4 mt-0.5 shrink-0" />
            <span>
              {isSearchUnavailable
                ? `Search is unavailable for this platform. ${error}`
                : error}
            </span>
          </div>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="flex flex-col gap-1 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3">
            {warnings.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
        )}

        {/* Results grid */}
        {results.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {results.map((item) => (
              <AnalysisCard
                key={item.note_id}
                title={item.title}
                author={item.author}
                likes={item.likes}
                comments={item.comments}
                collects={item.collects}
                platform={platform}
                contentType={item.content_type}
                url={item.url}
                onClick={() => handleCardClick(item)}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {hasSearched && !error && results.length === 0 && (
          <div className="text-center py-12 text-sm text-muted-foreground">
            No results found. Try a different keyword or platform.
          </div>
        )}
      </div>
    </main>
  );
}

export default function SearchPage() {
  return (
    <Suspense>
      <SearchContent />
    </Suspense>
  );
}
