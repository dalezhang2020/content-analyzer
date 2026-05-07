"""URL parsing for Xiaohongshu links."""
from __future__ import annotations
import re
from urllib.parse import urlparse


# Matches xhslink.com short links and xiaohongshu.com/explore/<note_id> or /discovery/item/<note_id>
_XHS_PATTERNS = [
    re.compile(r"https?://www\.xiaohongshu\.com/(?:explore|discovery/item)/(?P<id>[a-f0-9]+)"),
    re.compile(r"https?://xhslink\.com/\S+"),
]


def is_xiaohongshu_url(url: str) -> bool:
    """Return True if the URL looks like a Xiaohongshu note link."""
    host = urlparse(url).hostname or ""
    return host in ("www.xiaohongshu.com", "xhslink.com", "xiaohongshu.com")


def extract_note_id(url: str) -> str | None:
    """Extract the note ID from a canonical Xiaohongshu URL. Returns None for short links."""
    m = _XHS_PATTERNS[0].search(url)
    return m.group("id") if m else None
