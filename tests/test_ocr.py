"""Offline tests for OCR integration in Xiaohongshu adapter."""
from content_analyzer.adapters.xiaohongshu.ocr import (
    extract_text_from_urls,
    ocr_available,
)
from content_analyzer.adapters.xiaohongshu.fetcher import _extract_image_urls


# --- Image URL extraction ---


def test_extract_image_urls_from_note_data():
    note_data = {
        "imageList": [
            {"urlDefault": "https://img.xhs.com/a.jpg", "url": "https://img.xhs.com/a_small.jpg"},
            {"url": "//img.xhs.com/b.jpg"},
            {"urlDefault": "", "url": ""},
        ]
    }
    urls = _extract_image_urls(note_data)
    assert urls == ["https://img.xhs.com/a.jpg", "https://img.xhs.com/b.jpg"]


def test_extract_image_urls_empty():
    assert _extract_image_urls({}) == []
    assert _extract_image_urls({"imageList": []}) == []


# --- OCR graceful degradation ---


def test_ocr_skipped_when_no_provider_configured(monkeypatch):
    """When no provider is available, extract_text_from_urls returns a clear warning."""
    import content_analyzer.adapters.xiaohongshu.gpt4o_ocr as gpt4o_mod

    monkeypatch.delenv("OCR_PROVIDER", raising=False)
    monkeypatch.delenv("OPENAI_COMPAT_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_COMPAT_API_KEY", raising=False)
    monkeypatch.setattr(gpt4o_mod, "_HAS_OPENAI", False)

    texts, warnings, _, _ = extract_text_from_urls(["https://img.xhs.com/a.jpg"])
    assert texts == []
    assert any("no provider configured" in w for w in warnings)


def test_ocr_skipped_explicit_gpt4o_missing_config(monkeypatch):
    """When OCR_PROVIDER=gpt4o but env vars are missing, warns clearly."""
    import content_analyzer.adapters.xiaohongshu.gpt4o_ocr as gpt4o_mod

    monkeypatch.setenv("OCR_PROVIDER", "gpt4o")
    monkeypatch.delenv("OPENAI_COMPAT_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_COMPAT_API_KEY", raising=False)
    monkeypatch.setattr(gpt4o_mod, "_HAS_OPENAI", True)

    texts, warnings, _, _ = extract_text_from_urls(["https://img.xhs.com/a.jpg"])
    assert texts == []
    assert any("GPT-4o vision not configured" in w for w in warnings)


def test_ocr_empty_url_list():
    """No URLs means no work and no warnings."""
    texts, warnings, _, _ = extract_text_from_urls([])
    assert texts == []
    assert warnings == []


# --- Integration: OCR text merged into fetch_note output ---


def test_fetch_note_merges_ocr_text(monkeypatch):
    """When OCR returns text, it is appended to text_content."""
    import content_analyzer.adapters.xiaohongshu.fetcher as fetcher_mod
    import content_analyzer.adapters.xiaohongshu.ocr as ocr_mod

    monkeypatch.setattr(fetcher_mod, "_HAS_REQUESTS", True)

    # Mock requests.get to return a page with image list
    class FakeResp:
        status_code = 200
        url = "https://www.xiaohongshu.com/explore/abc123"
        text = (
            '<html><script>window.__INITIAL_STATE__='
            '{"note":{"noteDetailMap":{"abc123":{"note":{'
            '"title":"Image Note","desc":"Caption text",'
            '"user":{"nickname":"User1"},'
            '"interactInfo":{"likedCount":"10"},'
            '"imageList":[{"urlDefault":"https://img.xhs.com/pic1.jpg"}]'
            '}}}}}</script></html>'
        )

    import requests as req_mod

    monkeypatch.setattr(req_mod, "get", lambda *a, **kw: FakeResp())

    # Mock OCR dispatcher to return text
    def fake_extract_urls(urls, timeout=15):
        return (["OCR extracted text"], [], 0, 0)

    monkeypatch.setattr(ocr_mod, "extract_text_from_urls", fake_extract_urls)

    meta, text, warnings, _, _ = fetcher_mod.fetch_note(
        "https://www.xiaohongshu.com/explore/abc123"
    )
    assert meta.title == "Image Note"
    assert "Caption text" in text
    assert "[OCR]" in text
    assert "OCR extracted text" in text


def test_fetch_note_ocr_only_when_no_desc(monkeypatch):
    """When desc is empty, OCR text becomes the sole text_content."""
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

    def fake_extract_urls(urls, timeout=15):
        return (["Image text only"], [], 0, 0)

    monkeypatch.setattr(ocr_mod, "extract_text_from_urls", fake_extract_urls)

    meta, text, warnings, _, _ = fetcher_mod.fetch_note(
        "https://www.xiaohongshu.com/explore/abc123"
    )
    assert text == "Image text only"
    assert "[OCR]" not in text  # no merge marker when desc was empty
