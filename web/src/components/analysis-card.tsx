"use client";

import { Heart, MessageCircle, Bookmark } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export interface AnalysisCardProps {
  title: string;
  author?: string;
  likes?: number;
  comments?: number;
  collects?: number;
  platform: "xiaohongshu" | "youtube";
  contentType?: "normal" | "video";
  url?: string;
  onClick?: () => void;
}

const platformConfig = {
  xiaohongshu: { label: "小红书", className: "bg-rose-500/10 text-rose-600 border-rose-500/20" },
  youtube: { label: "YouTube", className: "bg-red-500/10 text-red-600 border-red-500/20" },
};

// Format large numbers compactly (e.g., 1200 -> 1.2k)
function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function AnalysisCard({
  title,
  author,
  likes,
  comments,
  collects,
  platform,
  contentType,
  url,
  onClick,
}: AnalysisCardProps) {
  const config = platformConfig[platform];

  const handleClick = () => {
    if (onClick) {
      onClick();
    } else if (url) {
      window.location.href = `/analyze?url=${encodeURIComponent(url)}`;
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      className={cn(
        "group relative flex flex-col gap-2 rounded-lg border border-border bg-card p-3",
        "cursor-pointer transition-all hover:border-amber-600/30 hover:shadow-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600/50"
      )}
    >
      {/* Header: platform badge + content type */}
      <div className="flex items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn("text-[10px] h-4 px-1.5", config.className)}
        >
          {config.label}
        </Badge>
        {contentType && contentType !== "normal" && (
          <span className="text-[10px] text-muted-foreground">{contentType}</span>
        )}
      </div>

      {/* Title */}
      <h3 className="text-sm font-medium leading-snug line-clamp-2 text-foreground group-hover:text-amber-700 transition-colors">
        {title}
      </h3>

      {/* Author */}
      {author && (
        <p className="text-xs text-muted-foreground truncate">@{author}</p>
      )}

      {/* Engagement metrics */}
      <div className="flex items-center gap-3 mt-auto pt-1">
        {likes != null && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Heart className="size-3" />
            {formatCount(likes)}
          </span>
        )}
        {comments != null && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <MessageCircle className="size-3" />
            {formatCount(comments)}
          </span>
        )}
        {collects != null && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Bookmark className="size-3" />
            {formatCount(collects)}
          </span>
        )}
      </div>
    </div>
  );
}
