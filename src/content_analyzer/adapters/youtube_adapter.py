"""YouTube platform adapter — wraps existing youtube/ module into the unified interface."""
from __future__ import annotations

from content_analyzer.adapters.base import PlatformAdapter, SearchResponse
from content_analyzer.adapters.youtube import fetch_metadata, fetch_transcript, fetch_comments
from content_analyzer.adapters.youtube.metadata import extract_video_id
from content_analyzer.analysis import get_analyzer
from content_analyzer.models import AnalysisResult

import re

_YT_HOSTS = {"www.youtube.com", "youtube.com", "youtu.be", "m.youtube.com"}


class YouTubeAdapter(PlatformAdapter):
    @property
    def platform_name(self) -> str:
        return "youtube"

    def detect(self, url: str) -> bool:
        from urllib.parse import urlparse
        host = urlparse(url).hostname or ""
        return host in _YT_HOSTS

    def fetch(self, url: str) -> AnalysisResult:
        warnings: list[str] = []
        metadata = fetch_metadata(url)
        video_id = extract_video_id(url)
        transcript = fetch_transcript(video_id)
        comments = fetch_comments(video_id)

        if metadata.title is None:
            warnings.append(
                "Metadata is incomplete. Install the optional 'full' dependencies to enable yt-dlp metadata fallback."
            )
        if transcript is None:
            warnings.append(
                "Transcript is unavailable. youtube-transcript-api failed and yt-dlp fallback is not active."
            )
        if comments is None:
            warnings.append(
                "Comments are unavailable. Set YOUTUBE_API_KEY and install google-api-python-client."
            )

        result = AnalysisResult(
            metadata=metadata,
            transcript=transcript,
            comments=comments,
            warnings=warnings,
        )

        analyzer = get_analyzer()
        result = analyzer.analyze(result)
        return result

    def check(self) -> tuple[bool, str]:
        try:
            import youtube_transcript_api  # noqa: F401
            return True, "youtube-transcript-api available"
        except ImportError:
            return False, "youtube-transcript-api not installed"
