"""Fetch and parse a Xiaohongshu note page for metadata and text content."""
from __future__ import annotations
import json
import re
from typing import Optional

from content_analyzer.models import Metadata

try:
    import requests  # type: ignore
    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False


_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def _resolve_short_link(url: str) -> str:
    """Follow xhslink.com redirect to get canonical URL."""
    if not _HAS_REQUESTS:
        return url
    resp = requests.head(url, headers=_HEADERS, allow_redirects=True, timeout=10)
    return resp.url


def _extract_initial_state(html: str) -> dict | None:
    """Extract __INITIAL_STATE__ JSON embedded in the page."""
    m = re.search(r"window\.__INITIAL_STATE__\s*=\s*(\{.+?\})\s*</script>", html, re.DOTALL)
    if not m:
        return None
    raw = m.group(1)
    # XHS sometimes uses undefined as a value; replace with null for valid JSON
    raw = raw.replace("undefined", "null")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _extract_image_urls(note_data: dict) -> list[str]:
    """Extract image URLs from note data structure."""
    urls: list[str] = []
    image_list = note_data.get("imageList", [])
    for img in image_list:
        # Prefer urlDefault (full-size), fall back to url
        img_url = img.get("urlDefault") or img.get("url") or ""
        if img_url:
            # Ensure https
            if img_url.startswith("//"):
                img_url = "https:" + img_url
            urls.append(img_url)
    return urls


def fetch_note(url: str) -> tuple[Metadata, Optional[str], list[str], int, int]:
    """Fetch a Xiaohongshu note. Returns (metadata, text_content, warnings, prompt_tokens, completion_tokens)."""
    warnings: list[str] = []

    if not _HAS_REQUESTS:
        warnings.append("requests library not installed; cannot fetch Xiaohongshu page. Install with: pip install requests")
        return Metadata(video_id=url, title=None), None, warnings, 0, 0

    from content_analyzer.adapters.xiaohongshu.url import extract_note_id, is_xiaohongshu_url
    from urllib.parse import urlparse

    # Resolve short links
    canonical = url
    host = urlparse(url).hostname or ""
    if host == "xhslink.com":
        try:
            canonical = _resolve_short_link(url)
        except Exception as e:
            warnings.append(f"Failed to resolve short link: {e}")
            return Metadata(video_id=url, title=None), None, warnings, 0, 0

    note_id = extract_note_id(canonical) or canonical

    try:
        resp = requests.get(canonical, headers=_HEADERS, timeout=15)
    except Exception as e:
        warnings.append(f"Network error fetching Xiaohongshu page: {e}")
        return Metadata(video_id=note_id, title=None), None, warnings, 0, 0

    if resp.status_code == 403 or "请验证" in resp.text or "login" in resp.url:
        warnings.append("Xiaohongshu returned a login/captcha wall. Content extraction blocked by anti-bot measures.")
        return Metadata(video_id=note_id, title=None), None, warnings, 0, 0

    if resp.status_code != 200:
        warnings.append(f"Xiaohongshu returned HTTP {resp.status_code}.")
        return Metadata(video_id=note_id, title=None), None, warnings, 0, 0

    html = resp.text
    state = _extract_initial_state(html)

    title: str | None = None
    text_content: str | None = None
    channel: str | None = None
    likes: int | None = None

    if state:
        # Navigate the nested state – structure varies but common paths:
        note_data = None
        try:
            # Common path: state.note.noteDetailMap.<id>.note
            detail_map = state.get("note", {}).get("noteDetailMap", {})
            if detail_map:
                first_key = next(iter(detail_map))
                note_data = detail_map[first_key].get("note", {})
        except (StopIteration, AttributeError):
            pass

        if note_data:
            title = note_data.get("title")
            desc = note_data.get("desc", "")
            text_content = desc if desc else None
            user = note_data.get("user", {})
            channel = user.get("nickname")
            interact = note_data.get("interactInfo", {})
            liked_count = interact.get("likedCount")
            if liked_count and str(liked_count).isdigit():
                likes = int(liked_count)
        else:
            warnings.append("Could not locate note data in page state; page structure may have changed.")
    else:
        # Fallback: try og:title meta tag
        og_match = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]*)"', html)
        if og_match:
            title = og_match.group(1)
        desc_match = re.search(r'<meta[^>]+name="description"[^>]+content="([^"]*)"', html)
        if desc_match:
            text_content = desc_match.group(1)
        if not title and not text_content:
            warnings.append("Page HTML did not contain extractable __INITIAL_STATE__ or meta tags. Anti-bot may be active.")

    # --- OCR for image-based notes ---
    image_urls: list[str] = []
    if state and note_data:
        image_urls = _extract_image_urls(note_data)

    if image_urls:
        from content_analyzer.adapters.xiaohongshu.ocr import extract_text_from_urls

        ocr_texts, ocr_warnings, ocr_prompt_tokens, ocr_completion_tokens = extract_text_from_urls(image_urls)
        warnings.extend(ocr_warnings)
        if ocr_texts:
            ocr_combined = "\n".join(ocr_texts)
            # Detect structured gpt4o output (contains markdown headings)
            is_structured = any(line.startswith("## ") for line in ocr_combined.splitlines())
            marker = "[Image Analysis]" if is_structured else "[OCR]"
            # Merge: page text first, then extracted content
            if text_content:
                text_content = text_content + f"\n\n{marker}\n" + ocr_combined
            else:
                text_content = ocr_combined
    else:
        ocr_prompt_tokens = 0
        ocr_completion_tokens = 0

    metadata = Metadata(
        video_id=note_id,
        title=title,
        channel=channel,
        view_count=likes,  # repurpose view_count for likes in XHS context
    )

    return metadata, text_content, warnings, ocr_prompt_tokens, ocr_completion_tokens
