"""GPT-4o vision OCR provider via OpenAI-compatible endpoint (e.g. Azure Foundry).

When used for social-media images, this provider extracts creator-useful structure
(title, headings, key claims, stats, CTAs, visual framing) rather than raw OCR text.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

try:
    from openai import OpenAI  # type: ignore

    _HAS_OPENAI = True
except ImportError:
    _HAS_OPENAI = False

logger = logging.getLogger(__name__)

# Creator-analysis prompt for social-media images
_CREATOR_ANALYSIS_PROMPT = (
    "You are analyzing a social-media image (e.g. Xiaohongshu, Instagram, TikTok screenshot). "
    "Extract structured creator-useful information from the image. Return the following sections, "
    "using the exact headers below. Omit a section only if nothing relevant is visible.\n\n"
    "## Title\nThe main title or headline text.\n\n"
    "## Headings\nSection headings or sub-titles, one per line.\n\n"
    "## Key Claims\nCore factual claims, tips, or assertions made, one per line.\n\n"
    "## Stats\nAny numbers, metrics, percentages, or data points mentioned.\n\n"
    "## CTA\nCalls to action (follow, like, save, link in bio, etc.).\n\n"
    "## Visual Framing\nNotable layout, design choices, or visual techniques "
    "(e.g. before/after, numbered list, bold highlight, emoji usage).\n\n"
    "## Raw Text\nAny remaining visible text not captured above, preserving order.\n\n"
    "Be concise. Use the original language of the image (Chinese, English, etc.). "
    "Do not add commentary or interpretation beyond what is visible."
)


def _get_config() -> tuple[Optional[str], Optional[str], str]:
    """Return (base_url, api_key, model) from env."""
    base_url = os.environ.get("OPENAI_COMPAT_BASE_URL")
    api_key = os.environ.get("OPENAI_COMPAT_API_KEY")
    model = os.environ.get("OPENAI_COMPAT_MODEL", "gpt-4o")
    return base_url, api_key, model


def gpt4o_ocr_available() -> bool:
    """Return True if GPT-4o vision provider is configured and SDK is present."""
    base_url, api_key, _ = _get_config()
    return bool(base_url and api_key and _HAS_OPENAI)


def get_prompt() -> str:
    """Return the creator-analysis prompt (exposed for testing)."""
    return _CREATOR_ANALYSIS_PROMPT


def extract_text_from_url(image_url: str, timeout: int = 60) -> Optional[str]:
    """Send an image URL to GPT-4o via Responses API and return structured analysis."""
    if not _HAS_OPENAI:
        return None

    base_url, api_key, model = _get_config()
    if not base_url or not api_key:
        return None

    try:
        client = OpenAI(base_url=base_url, api_key=api_key)
        response = client.responses.create(
            model=model,
            input=[
                {
                    "role": "user",
                    "content": [
                        {"type": "input_image", "image_url": image_url},
                        {"type": "input_text", "text": _CREATOR_ANALYSIS_PROMPT},
                    ],
                }
            ],
        )
        text = response.output_text
        return text.strip() if text else None
    except Exception as e:
        logger.warning("GPT-4o vision analysis failed for %s: %s", image_url, e)
        return None


def extract_text_from_urls(
    image_urls: list[str], timeout: int = 60
) -> tuple[list[str], list[str]]:
    """Run GPT-4o vision analysis on multiple image URLs.

    Returns (extracted_texts, warnings).
    """
    warnings: list[str] = []
    if not image_urls:
        return [], warnings

    if not _HAS_OPENAI:
        warnings.append("GPT-4o OCR skipped: openai SDK not installed. Install with: pip install openai")
        return [], warnings

    base_url, api_key, _ = _get_config()
    if not base_url or not api_key:
        missing = []
        if not base_url:
            missing.append("OPENAI_COMPAT_BASE_URL")
        if not api_key:
            missing.append("OPENAI_COMPAT_API_KEY")
        warnings.append(f"GPT-4o OCR skipped: missing env var(s) ({', '.join(missing)}).")
        return [], warnings

    texts: list[str] = []
    for url in image_urls:
        text = extract_text_from_url(url, timeout=timeout)
        if text:
            texts.append(text)

    if not texts and image_urls:
        warnings.append(f"GPT-4o vision ran on {len(image_urls)} image(s) but extracted no content.")

    return texts, warnings
