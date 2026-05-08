"""Base adapter interface — all platform adapters implement this contract.

Inspired by Agent-Reach's pluggable channel architecture:
each platform is an independent module with a unified interface.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

from content_analyzer.models import AnalysisResult, Metadata


@dataclass
class SearchResult:
    """A single item from a platform search."""

    note_id: str
    title: str
    url: str
    author: Optional[str] = None
    likes: int = 0
    comments: int = 0
    collects: int = 0
    content_type: str = "normal"  # "normal" (image-text) or "video"
    snippet: Optional[str] = None


@dataclass
class SearchResponse:
    """Response from a search operation."""

    items: list[SearchResult] = field(default_factory=list)
    keyword: str = ""
    platform: str = ""
    total: int = 0
    warnings: list[str] = field(default_factory=list)


class PlatformAdapter(ABC):
    """Abstract base for all platform adapters.

    Each adapter provides:
    - detect(): check if a URL belongs to this platform
    - fetch(): extract content from a single URL
    - search(): search for content by keyword (optional)
    - check(): verify the adapter's dependencies are available
    """

    @property
    @abstractmethod
    def platform_name(self) -> str:
        """Human-readable platform name (e.g. 'xiaohongshu', 'youtube')."""
        ...

    @abstractmethod
    def detect(self, url: str) -> bool:
        """Return True if this adapter can handle the given URL."""
        ...

    @abstractmethod
    def fetch(self, url: str) -> AnalysisResult:
        """Fetch and analyze content from a single URL."""
        ...

    def search(self, keyword: str, page: int = 1, sort: str = "general") -> SearchResponse:
        """Search for content by keyword. Override in subclasses that support search."""
        return SearchResponse(
            keyword=keyword,
            platform=self.platform_name,
            warnings=[f"{self.platform_name} adapter does not support search."],
        )

    def check(self) -> tuple[bool, str]:
        """Check if this adapter's dependencies are available.

        Returns (is_available, status_message).
        """
        return True, "OK"
