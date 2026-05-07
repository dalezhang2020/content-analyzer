"""YouTube metadata extraction."""
from __future__ import annotations
import re
from content_analyzer.models import Metadata


_VIDEO_ID_RE = re.compile(
    r"(?:v=|youtu\.be/|/shorts/|/embed/)([A-Za-z0-9_-]{11})"
)


def extract_video_id(url: str) -> str:
    m = _VIDEO_ID_RE.search(url)
    if not m:
        raise ValueError(f"Cannot extract video ID from: {url}")
    return m.group(1)


def fetch_metadata(url: str) -> Metadata:
    video_id = extract_video_id(url)
    # Try yt-dlp for metadata (lightweight info-only call)
    try:
        import yt_dlp  # noqa: F401

        ydl_opts = {"quiet": True, "skip_download": True, "no_warnings": True}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            return Metadata(
                video_id=video_id,
                title=info.get("title"),
                channel=info.get("channel") or info.get("uploader"),
                publish_date=info.get("upload_date"),
                duration_seconds=info.get("duration"),
                view_count=info.get("view_count"),
            )
    except Exception:
        pass
    # Fallback: return minimal metadata
    return Metadata(video_id=video_id)
