"""Mistral OCR provider via Azure Foundry."""
from __future__ import annotations

import logging
import os
from typing import Optional

try:
    import requests as _requests

    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False

logger = logging.getLogger(__name__)


def _get_config() -> tuple[Optional[str], Optional[str], str]:
    """Return (endpoint, api_key, model) from env. Any may be None."""
    endpoint = os.environ.get("AZURE_FOUNDRY_ENDPOINT")
    api_key = os.environ.get("AZURE_FOUNDRY_API_KEY")
    model = os.environ.get("AZURE_FOUNDRY_MODEL", "mistral-ocr-2505-preview")
    return endpoint, api_key, model


def mistral_ocr_available() -> bool:
    """Return True if Mistral OCR via Azure Foundry is configured."""
    endpoint, api_key, _ = _get_config()
    return bool(endpoint and api_key and _HAS_REQUESTS)


def extract_text_from_url(image_url: str, timeout: int = 30) -> Optional[str]:
    """Send an image URL to Mistral OCR on Azure Foundry and return extracted text."""
    if not _HAS_REQUESTS:
        return None

    endpoint, api_key, model = _get_config()
    if not endpoint or not api_key:
        return None

    # Azure AI Foundry Model Inference endpoint for services.ai.azure.com
    url = f"{endpoint.rstrip('/')}/models/chat/completions?api-version=2024-05-01-preview"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": image_url},
                    },
                    {
                        "type": "text",
                        "text": "Extract all text from this image. Return only the extracted text, nothing else.",
                    },
                ],
            }
        ],
        "max_tokens": 4096,
    }

    try:
        resp = _requests.post(url, json=payload, headers=headers, timeout=timeout)
        if resp.status_code != 200:
            logger.warning("Mistral OCR returned HTTP %d: %s", resp.status_code, resp.text[:200])
            return None
        data = resp.json()
        text = data["choices"][0]["message"]["content"]
        return text.strip() or None
    except Exception as e:
        logger.warning("Mistral OCR request failed: %s", e)
        return None


def extract_text_from_urls(
    image_urls: list[str], timeout: int = 30
) -> tuple[list[str], list[str]]:
    """Run Mistral OCR on multiple image URLs.

    Returns (extracted_texts, warnings).
    """
    warnings: list[str] = []
    if not image_urls:
        return [], warnings

    if not _HAS_REQUESTS:
        warnings.append("Mistral OCR skipped: requests library not available.")
        return [], warnings

    endpoint, api_key, _ = _get_config()
    if not endpoint or not api_key:
        missing = []
        if not endpoint:
            missing.append("AZURE_FOUNDRY_ENDPOINT")
        if not api_key:
            missing.append("AZURE_FOUNDRY_API_KEY")
        warnings.append(
            f"Mistral OCR skipped: missing env var(s) ({', '.join(missing)})."
        )
        return [], warnings

    texts: list[str] = []
    for url in image_urls:
        text = extract_text_from_url(url, timeout=timeout)
        if text:
            texts.append(text)

    if not texts and image_urls:
        warnings.append(
            f"Mistral OCR ran on {len(image_urls)} image(s) but extracted no text."
        )

    return texts, warnings
