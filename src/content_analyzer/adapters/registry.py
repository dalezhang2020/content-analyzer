"""Adapter registry — auto-discovers and manages platform adapters.

Usage:
    from content_analyzer.adapters.registry import get_adapter, get_all_adapters, detect_platform

    adapter = detect_platform(url)  # returns the right adapter for a URL
    result = adapter.fetch(url)

    # Or search
    adapter = get_adapter("xiaohongshu")
    results = adapter.search("AI编程")
"""
from __future__ import annotations

from typing import Optional

from content_analyzer.adapters.base import PlatformAdapter


# Global registry
_adapters: dict[str, PlatformAdapter] = {}


def register(adapter: PlatformAdapter) -> None:
    """Register an adapter instance."""
    _adapters[adapter.platform_name] = adapter


def get_adapter(platform: str) -> Optional[PlatformAdapter]:
    """Get adapter by platform name."""
    return _adapters.get(platform)


def get_all_adapters() -> dict[str, PlatformAdapter]:
    """Get all registered adapters."""
    return dict(_adapters)


def detect_platform(url: str) -> Optional[PlatformAdapter]:
    """Auto-detect which adapter handles a URL."""
    for adapter in _adapters.values():
        if adapter.detect(url):
            return adapter
    return None


def doctor() -> dict[str, tuple[bool, str]]:
    """Check health of all registered adapters."""
    results = {}
    for name, adapter in _adapters.items():
        results[name] = adapter.check()
    return results


# --- Auto-registration on import ---

def _register_all() -> None:
    """Register all built-in adapters."""
    from content_analyzer.adapters.youtube_adapter import YouTubeAdapter
    from content_analyzer.adapters.xiaohongshu_adapter import XiaohongshuAdapter

    register(YouTubeAdapter())
    register(XiaohongshuAdapter())


_register_all()
