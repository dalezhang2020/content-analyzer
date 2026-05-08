"use client";

import { useRef, useEffect } from "react";
import { Download } from "lucide-react";

export interface VideoPlayerProps {
  /** URL to the video file (e.g. /videos/video-1717232400000.mp4) */
  src: string;
  /** Auto-play when the component mounts (default: true) */
  autoPlay?: boolean;
  /** Callback when video playback ends */
  onEnded?: () => void;
}

/**
 * Inline MP4 player with native HTML5 controls and a download link.
 * Designed for displaying rendered teardown videos after generation.
 */
export function VideoPlayer({ src, autoPlay = true, onEnded }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Extract filename from the src path for display
  const filename = src.split("/").pop() || "video.mp4";

  useEffect(() => {
    if (autoPlay && videoRef.current) {
      // Attempt autoplay — browsers may block unmuted autoplay
      const playPromise = videoRef.current.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          // Silently handle autoplay rejection (browser policy)
        });
      }
    }
  }, [autoPlay, src]);

  return (
    <div className="w-full space-y-3">
      {/* Video container with 16:9 aspect ratio */}
      <div className="relative w-full overflow-hidden rounded-lg border border-border bg-black"
        style={{ aspectRatio: "16 / 9" }}
      >
        <video
          ref={videoRef}
          src={src}
          controls
          onEnded={onEnded}
          className="absolute inset-0 h-full w-full object-contain"
          playsInline
        />
      </div>

      {/* Footer: filename label + download link */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground truncate max-w-[60%]">
          {filename}
        </span>
        <a
          href={src}
          download={filename}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
      </div>
    </div>
  );
}
