"""Platform adapters — pluggable architecture for content extraction.

Each platform has its own adapter module implementing PlatformAdapter.
Use the registry to auto-detect platforms or access adapters by name.
"""
from content_analyzer.adapters.base import PlatformAdapter, SearchResult, SearchResponse
from content_analyzer.adapters.registry import (
    detect_platform,
    get_adapter,
    get_all_adapters,
    register,
    doctor,
)

__all__ = [
    "PlatformAdapter",
    "SearchResult",
    "SearchResponse",
    "detect_platform",
    "get_adapter",
    "get_all_adapters",
    "register",
    "doctor",
]
