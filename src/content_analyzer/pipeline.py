"""Pipeline orchestration — unified entry point using adapter registry."""
from __future__ import annotations

from content_analyzer.adapters.base import SearchResponse
from content_analyzer.adapters.registry import detect_platform, get_adapter
from content_analyzer.models import AnalysisResult


def analyze_url(url: str) -> AnalysisResult:
    """Analyze any supported URL. Auto-detects platform."""
    adapter = detect_platform(url)
    if adapter is None:
        return AnalysisResult(
            metadata=__import__("content_analyzer.models", fromlist=["Metadata"]).Metadata(
                video_id=url, title=None
            ),
            warnings=[f"No adapter found for URL: {url}"],
        )
    return adapter.fetch(url)


def search(keyword: str, platform: str = "xiaohongshu", page: int = 1, sort: str = "general") -> SearchResponse:
    """Search for content on a platform by keyword."""
    adapter = get_adapter(platform)
    if adapter is None:
        return SearchResponse(
            keyword=keyword,
            platform=platform,
            warnings=[f"Unknown platform: {platform}. Available: xiaohongshu, youtube"],
        )
    return adapter.search(keyword, page=page, sort=sort)


# --- Legacy API (backward compatible) ---

def analyze_xiaohongshu(url: str) -> AnalysisResult:
    """Analyze a single Xiaohongshu note URL. (Legacy API)"""
    adapter = get_adapter("xiaohongshu")
    assert adapter is not None
    return adapter.fetch(url)


def analyze_youtube(url: str) -> AnalysisResult:
    """Analyze a YouTube video URL. (Legacy API)"""
    adapter = get_adapter("youtube")
    assert adapter is not None
    return adapter.fetch(url)
