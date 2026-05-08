"""Optional OCR support for Xiaohongshu image-based notes."""
from __future__ import annotations

import logging
import os
from typing import Optional

try:
    import requests as _requests  # type: ignore

    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False

logger = logging.getLogger(__name__)


def _get_ocr_provider() -> str:
    """Return the configured OCR provider name (lowercase).

    Default: 'auto' which uses gpt4o if configured, otherwise skips.
    """
    return os.environ.get("OCR_PROVIDER", "auto").lower().strip()


def _resolve_provider() -> str:
    """Resolve 'auto' to the best available provider, or return explicit choice."""
    provider = _get_ocr_provider()
    if provider != "auto":
        return provider
    # Auto-detect: use gpt4o if available, otherwise none
    from content_analyzer.adapters.xiaohongshu.gpt4o_ocr import gpt4o_ocr_available
    if gpt4o_ocr_available():
        return "gpt4o"
    return "none"


def ocr_available() -> bool:
    """Return True if any OCR backend is usable."""
    provider = _resolve_provider()
    if provider == "gpt4o":
        from content_analyzer.adapters.xiaohongshu.gpt4o_ocr import gpt4o_ocr_available
        return gpt4o_ocr_available()
    if provider == "mistral":
        from content_analyzer.adapters.xiaohongshu.mistral_ocr import mistral_ocr_available
        return mistral_ocr_available()
    return False


def extract_text_from_urls(
    image_urls: list[str], timeout: int = 15
) -> tuple[list[str], list[str], int, int]:
    """Run image analysis on multiple image URLs using the configured provider.

    Provider resolution: auto (gpt4o if configured, else skip), or explicit choice.
    Returns (extracted_texts, warnings, prompt_tokens, completion_tokens).
    """
    warnings: list[str] = []
    if not image_urls:
        return [], warnings, 0, 0

    provider = _resolve_provider()

    if provider == "gpt4o":
        from content_analyzer.adapters.xiaohongshu.gpt4o_ocr import (
            extract_text_from_urls as gpt4o_extract,
            gpt4o_ocr_available,
        )
        if not gpt4o_ocr_available():
            warnings.append(
                "Image analysis skipped: GPT-4o vision not configured. "
                "Set OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY to enable."
            )
            return [], warnings, 0, 0
        return gpt4o_extract(image_urls, timeout=timeout)

    elif provider == "mistral":
        from content_analyzer.adapters.xiaohongshu.mistral_ocr import (
            extract_text_from_urls as mistral_extract,
            mistral_ocr_available,
        )
        if not mistral_ocr_available():
            warnings.append(
                "Image analysis skipped: Mistral OCR not configured. "
                "Set AZURE_FOUNDRY_ENDPOINT and AZURE_FOUNDRY_API_KEY to enable."
            )
            return [], warnings, 0, 0
        texts, w = mistral_extract(image_urls, timeout=timeout)
        return texts, w, 0, 0

    # No provider available (auto resolved to 'none')
    warnings.append(
        "Image analysis skipped: no provider configured. "
        "Set OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY for GPT-4o vision."
    )
    return [], warnings, 0, 0
