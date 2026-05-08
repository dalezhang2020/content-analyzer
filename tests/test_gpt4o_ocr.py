"""Offline tests for GPT-4o vision OCR provider."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


# --- Provider priority / auto-selection ---


def test_default_provider_is_auto(monkeypatch):
    """Default OCR_PROVIDER is 'auto'."""
    monkeypatch.delenv("OCR_PROVIDER", raising=False)
    from content_analyzer.adapters.xiaohongshu.ocr import _get_ocr_provider

    assert _get_ocr_provider() == "auto"


def test_auto_prefers_gpt4o_when_configured(monkeypatch):
    """Auto mode resolves to gpt4o when it is available."""
    monkeypatch.delenv("OCR_PROVIDER", raising=False)
    monkeypatch.setenv("OPENAI_COMPAT_BASE_URL", "https://example.com/openai/v1")
    monkeypatch.setenv("OPENAI_COMPAT_API_KEY", "test-key")

    import content_analyzer.adapters.xiaohongshu.gpt4o_ocr as gpt4o_mod

    monkeypatch.setattr(gpt4o_mod, "_HAS_OPENAI", True)

    from content_analyzer.adapters.xiaohongshu.ocr import _resolve_provider

    assert _resolve_provider() == "gpt4o"


def test_auto_falls_to_none_when_gpt4o_unconfigured(monkeypatch):
    """Auto mode resolves to 'none' when gpt4o is not configured."""
    monkeypatch.delenv("OCR_PROVIDER", raising=False)
    monkeypatch.delenv("OPENAI_COMPAT_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_COMPAT_API_KEY", raising=False)

    import content_analyzer.adapters.xiaohongshu.gpt4o_ocr as gpt4o_mod

    monkeypatch.setattr(gpt4o_mod, "_HAS_OPENAI", False)

    from content_analyzer.adapters.xiaohongshu.ocr import _resolve_provider

    assert _resolve_provider() == "none"


def test_explicit_provider_overrides_auto(monkeypatch):
    """Explicit OCR_PROVIDER=mistral bypasses auto-detection."""
    monkeypatch.setenv("OCR_PROVIDER", "mistral")
    monkeypatch.setenv("OPENAI_COMPAT_BASE_URL", "https://example.com/openai/v1")
    monkeypatch.setenv("OPENAI_COMPAT_API_KEY", "test-key")

    import content_analyzer.adapters.xiaohongshu.gpt4o_ocr as gpt4o_mod

    monkeypatch.setattr(gpt4o_mod, "_HAS_OPENAI", True)

    from content_analyzer.adapters.xiaohongshu.ocr import _resolve_provider

    assert _resolve_provider() == "mistral"


# --- Provider availability ---


def test_ocr_available_gpt4o_when_configured(monkeypatch):
    """ocr_available() returns True when gpt4o provider is fully configured."""
    monkeypatch.setenv("OCR_PROVIDER", "gpt4o")
    monkeypatch.setenv("OPENAI_COMPAT_BASE_URL", "https://example.services.ai.azure.com/openai/v1")
    monkeypatch.setenv("OPENAI_COMPAT_API_KEY", "test-key")

    import content_analyzer.adapters.xiaohongshu.gpt4o_ocr as gpt4o_mod

    monkeypatch.setattr(gpt4o_mod, "_HAS_OPENAI", True)

    from content_analyzer.adapters.xiaohongshu.ocr import ocr_available

    assert ocr_available() is True


def test_ocr_available_gpt4o_missing_sdk(monkeypatch):
    """ocr_available() returns False when openai SDK is missing."""
    monkeypatch.setenv("OCR_PROVIDER", "gpt4o")
    monkeypatch.setenv("OPENAI_COMPAT_BASE_URL", "https://example.com/openai/v1")
    monkeypatch.setenv("OPENAI_COMPAT_API_KEY", "test-key")

    import content_analyzer.adapters.xiaohongshu.gpt4o_ocr as gpt4o_mod

    monkeypatch.setattr(gpt4o_mod, "_HAS_OPENAI", False)

    from content_analyzer.adapters.xiaohongshu.ocr import ocr_available

    assert ocr_available() is False


# --- Graceful degradation ---


def test_extract_skipped_missing_sdk(monkeypatch):
    """extract_text_from_urls warns when openai SDK is not installed."""
    monkeypatch.setenv("OCR_PROVIDER", "gpt4o")

    import content_analyzer.adapters.xiaohongshu.gpt4o_ocr as gpt4o_mod

    monkeypatch.setattr(gpt4o_mod, "_HAS_OPENAI", False)

    from content_analyzer.adapters.xiaohongshu.gpt4o_ocr import extract_text_from_urls

    texts, warnings, _, _ = extract_text_from_urls(["https://img.xhs.com/a.jpg"])
    assert texts == []
    assert any("openai SDK" in w for w in warnings)


def test_extract_skipped_missing_env(monkeypatch):
    """extract_text_from_urls warns when env vars are missing."""
    monkeypatch.delenv("OPENAI_COMPAT_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_COMPAT_API_KEY", raising=False)

    import content_analyzer.adapters.xiaohongshu.gpt4o_ocr as gpt4o_mod

    monkeypatch.setattr(gpt4o_mod, "_HAS_OPENAI", True)

    from content_analyzer.adapters.xiaohongshu.gpt4o_ocr import extract_text_from_urls

    texts, warnings, _, _ = extract_text_from_urls(["https://img.xhs.com/a.jpg"])
    assert texts == []
    assert any("OPENAI_COMPAT_BASE_URL" in w for w in warnings)


def test_dispatcher_fallback_gpt4o_to_skip(monkeypatch):
    """When gpt4o is explicitly set but not configured, skips with clear warning."""
    monkeypatch.setenv("OCR_PROVIDER", "gpt4o")
    monkeypatch.delenv("OPENAI_COMPAT_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_COMPAT_API_KEY", raising=False)

    import content_analyzer.adapters.xiaohongshu.gpt4o_ocr as gpt4o_mod
    import content_analyzer.adapters.xiaohongshu.ocr as ocr_mod

    monkeypatch.setattr(gpt4o_mod, "_HAS_OPENAI", True)

    texts, warnings, _, _ = ocr_mod.extract_text_from_urls(["https://img.xhs.com/a.jpg"])
    assert texts == []
    assert any("GPT-4o vision not configured" in w for w in warnings)


# --- Prompt construction ---


def test_prompt_contains_creator_structure():
    """The gpt4o prompt requests structured creator-useful sections."""
    from content_analyzer.adapters.xiaohongshu.gpt4o_ocr import get_prompt

    prompt = get_prompt()
    assert "## Title" in prompt
    assert "## Key Claims" in prompt
    assert "## Stats" in prompt
    assert "## CTA" in prompt
    assert "## Visual Framing" in prompt
    assert "## Headings" in prompt


def test_request_construction_uses_creator_prompt(monkeypatch):
    """Verify the SDK call sends the creator-analysis prompt, not plain OCR."""
    monkeypatch.setenv("OPENAI_COMPAT_BASE_URL", "https://example.services.ai.azure.com/openai/v1")
    monkeypatch.setenv("OPENAI_COMPAT_API_KEY", "test-key-123")
    monkeypatch.setenv("OPENAI_COMPAT_MODEL", "my-gpt4o-deploy")

    import content_analyzer.adapters.xiaohongshu.gpt4o_ocr as gpt4o_mod

    monkeypatch.setattr(gpt4o_mod, "_HAS_OPENAI", True)

    mock_response = MagicMock()
    mock_response.output_text = "## Title\nTest Title\n## Key Claims\n- Claim 1"

    mock_responses = MagicMock()
    mock_responses.create = MagicMock(return_value=mock_response)

    mock_client = MagicMock()
    mock_client.responses = mock_responses

    mock_openai_cls = MagicMock(return_value=mock_client)

    with patch.object(gpt4o_mod, "OpenAI", mock_openai_cls, create=True):
        result = gpt4o_mod.extract_text_from_url("https://img.xhs.com/test.jpg")

    # Verify OpenAI client was constructed with correct params
    mock_openai_cls.assert_called_once_with(
        base_url="https://example.services.ai.azure.com/openai/v1",
        api_key="test-key-123",
    )
    # Verify responses.create was called with correct shape
    mock_responses.create.assert_called_once()
    call_kwargs = mock_responses.create.call_args[1]
    assert call_kwargs["model"] == "my-gpt4o-deploy"
    assert call_kwargs["input"][0]["role"] == "user"
    content = call_kwargs["input"][0]["content"]
    assert any(c.get("type") == "input_image" for c in content)
    # Verify the prompt is the creator-analysis one, not plain OCR
    text_items = [c for c in content if c.get("type") == "input_text"]
    assert len(text_items) == 1
    assert "## Title" in text_items[0]["text"]
    assert "## Key Claims" in text_items[0]["text"]
    assert result[0] == "## Title\nTest Title\n## Key Claims\n- Claim 1"


# --- Merge behavior in fetch_note ---


def test_fetch_note_merges_structured_gpt4o_output(monkeypatch):
    """Structured gpt4o output uses [Image Analysis] marker in merged text."""
    monkeypatch.setenv("OCR_PROVIDER", "gpt4o")

    import content_analyzer.adapters.xiaohongshu.fetcher as fetcher_mod
    import content_analyzer.adapters.xiaohongshu.ocr as ocr_mod

    monkeypatch.setattr(fetcher_mod, "_HAS_REQUESTS", True)

    class FakeResp:
        status_code = 200
        url = "https://www.xiaohongshu.com/explore/abc123"
        text = (
            '<html><script>window.__INITIAL_STATE__='
            '{"note":{"noteDetailMap":{"abc123":{"note":{'
            '"title":"Vision Test","desc":"Some caption",'
            '"user":{"nickname":"Tester"},'
            '"interactInfo":{"likedCount":"5"},'
            '"imageList":[{"urlDefault":"https://img.xhs.com/v1.jpg"}]'
            '}}}}}</script></html>'
        )

    import requests as req_mod

    monkeypatch.setattr(req_mod, "get", lambda *a, **kw: FakeResp())

    # Mock the OCR dispatcher to return structured gpt4o output
    structured_output = "## Title\n5个高效学习方法\n## Key Claims\n- 番茄工作法提升专注力"

    def fake_extract_urls(urls, timeout=15):
        return ([structured_output], [], 100, 50)

    monkeypatch.setattr(ocr_mod, "extract_text_from_urls", fake_extract_urls)

    meta, text, warnings, _, _ = fetcher_mod.fetch_note(
        "https://www.xiaohongshu.com/explore/abc123"
    )
    assert meta.title == "Vision Test"
    assert "Some caption" in text
    assert "[Image Analysis]" in text
    assert "5个高效学习方法" in text


def test_fetch_note_merges_plain_ocr_with_ocr_marker(monkeypatch):
    """Plain OCR output (no ## headings) uses [OCR] marker."""
    monkeypatch.setenv("OCR_PROVIDER", "gpt4o")

    import content_analyzer.adapters.xiaohongshu.fetcher as fetcher_mod
    import content_analyzer.adapters.xiaohongshu.ocr as ocr_mod

    monkeypatch.setattr(fetcher_mod, "_HAS_REQUESTS", True)

    class FakeResp:
        status_code = 200
        url = "https://www.xiaohongshu.com/explore/abc123"
        text = (
            '<html><script>window.__INITIAL_STATE__='
            '{"note":{"noteDetailMap":{"abc123":{"note":{'
            '"title":"Plain Note","desc":"Caption",'
            '"user":{"nickname":"U"},'
            '"interactInfo":{},'
            '"imageList":[{"urlDefault":"https://img.xhs.com/x.jpg"}]'
            '}}}}}</script></html>'
        )

    import requests as req_mod

    monkeypatch.setattr(req_mod, "get", lambda *a, **kw: FakeResp())

    def fake_extract_urls(urls, timeout=15):
        return (["Just plain text without markdown headings"], [], 80, 40)

    monkeypatch.setattr(ocr_mod, "extract_text_from_urls", fake_extract_urls)

    meta, text, warnings, _, _ = fetcher_mod.fetch_note(
        "https://www.xiaohongshu.com/explore/abc123"
    )
    assert "[OCR]" in text
    assert "[Image Analysis]" not in text


def test_fetch_note_structured_only_when_no_desc(monkeypatch):
    """When desc is empty, structured output becomes sole text_content without marker."""
    monkeypatch.setenv("OCR_PROVIDER", "gpt4o")

    import content_analyzer.adapters.xiaohongshu.fetcher as fetcher_mod
    import content_analyzer.adapters.xiaohongshu.ocr as ocr_mod

    monkeypatch.setattr(fetcher_mod, "_HAS_REQUESTS", True)

    class FakeResp:
        status_code = 200
        url = "https://www.xiaohongshu.com/explore/abc123"
        text = (
            '<html><script>window.__INITIAL_STATE__='
            '{"note":{"noteDetailMap":{"abc123":{"note":{'
            '"title":"Pic Only","desc":"",'
            '"user":{"nickname":"U"},'
            '"interactInfo":{},'
            '"imageList":[{"urlDefault":"https://img.xhs.com/x.jpg"}]'
            '}}}}}</script></html>'
        )

    import requests as req_mod

    monkeypatch.setattr(req_mod, "get", lambda *a, **kw: FakeResp())

    structured = "## Title\nSomething\n## Stats\n100k views"

    def fake_extract_urls(urls, timeout=15):
        return ([structured], [], 90, 45)

    monkeypatch.setattr(ocr_mod, "extract_text_from_urls", fake_extract_urls)

    meta, text, warnings, _, _ = fetcher_mod.fetch_note(
        "https://www.xiaohongshu.com/explore/abc123"
    )
    # No merge marker when desc was empty – raw structured content
    assert text == structured
    assert "[Image Analysis]" not in text
    assert "[OCR]" not in text
