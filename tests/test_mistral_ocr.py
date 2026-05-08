"""Offline tests for Mistral OCR provider and provider selection logic."""
import os

import pytest


# --- Provider selection ---


class TestProviderSelection:
    def test_default_provider_is_auto(self, monkeypatch):
        monkeypatch.delenv("OCR_PROVIDER", raising=False)
        from content_analyzer.adapters.xiaohongshu.ocr import _get_ocr_provider

        assert _get_ocr_provider() == "auto"

    def test_provider_from_env(self, monkeypatch):
        monkeypatch.setenv("OCR_PROVIDER", "mistral")
        from content_analyzer.adapters.xiaohongshu.ocr import _get_ocr_provider

        assert _get_ocr_provider() == "mistral"

    def test_provider_case_insensitive(self, monkeypatch):
        monkeypatch.setenv("OCR_PROVIDER", " Mistral ")
        from content_analyzer.adapters.xiaohongshu.ocr import _get_ocr_provider

        assert _get_ocr_provider() == "mistral"


# --- Mistral OCR availability ---


class TestMistralOcrAvailability:
    def test_available_when_configured(self, monkeypatch):
        monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://test.services.ai.azure.com")
        monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "fake-key")
        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mod

        monkeypatch.setattr(mod, "_HAS_REQUESTS", True)
        assert mod.mistral_ocr_available() is True

    def test_unavailable_missing_endpoint(self, monkeypatch):
        monkeypatch.delenv("AZURE_FOUNDRY_ENDPOINT", raising=False)
        monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "fake-key")
        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mod

        monkeypatch.setattr(mod, "_HAS_REQUESTS", True)
        assert mod.mistral_ocr_available() is False

    def test_unavailable_missing_key(self, monkeypatch):
        monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://test.services.ai.azure.com")
        monkeypatch.delenv("AZURE_FOUNDRY_API_KEY", raising=False)
        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mod

        monkeypatch.setattr(mod, "_HAS_REQUESTS", True)
        assert mod.mistral_ocr_available() is False

    def test_unavailable_no_requests(self, monkeypatch):
        monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://test.services.ai.azure.com")
        monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "fake-key")
        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mod

        monkeypatch.setattr(mod, "_HAS_REQUESTS", False)
        assert mod.mistral_ocr_available() is False


# --- Request construction ---


class TestMistralRequestConstruction:
    def test_request_payload_structure(self, monkeypatch):
        """Verify the HTTP request sent to Azure Foundry has correct structure."""
        monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://myres.services.ai.azure.com")
        monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "test-key-123")
        monkeypatch.setenv("AZURE_FOUNDRY_MODEL", "mistral-ocr-2505-preview")

        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mod

        monkeypatch.setattr(mod, "_HAS_REQUESTS", True)

        captured = {}

        def fake_post(url, json=None, headers=None, timeout=None):
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            captured["timeout"] = timeout

            class FakeResp:
                status_code = 200

                def json(self_):
                    return {"choices": [{"message": {"content": "Hello world"}}]}

            return FakeResp()

        monkeypatch.setattr(mod._requests, "post", fake_post)

        result = mod.extract_text_from_url("https://img.xhs.com/pic.jpg", timeout=20)

        assert result == "Hello world"
        assert captured["url"] == "https://myres.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview"
        assert captured["headers"]["Authorization"] == "Bearer test-key-123"
        assert captured["json"]["model"] == "mistral-ocr-2505-preview"
        # Verify image_url is in the message content
        content_parts = captured["json"]["messages"][0]["content"]
        image_part = next(p for p in content_parts if p["type"] == "image_url")
        assert image_part["image_url"]["url"] == "https://img.xhs.com/pic.jpg"
        assert captured["timeout"] == 20

    def test_route_uses_models_path_and_api_version(self, monkeypatch):
        """Lock: route must be /models/chat/completions with api-version query param."""
        monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://east-us.services.ai.azure.com")
        monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "k")

        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mod

        monkeypatch.setattr(mod, "_HAS_REQUESTS", True)

        captured = {}

        def fake_post(url, **kw):
            captured["url"] = url

            class R:
                status_code = 200
                def json(self): return {"choices": [{"message": {"content": "x"}}]}

            return R()

        monkeypatch.setattr(mod._requests, "post", fake_post)
        mod.extract_text_from_url("https://img.xhs.com/a.jpg")

        assert "/models/chat/completions" in captured["url"]
        assert "api-version=2024-05-01-preview" in captured["url"]
        assert "/v1/" not in captured["url"]

    def test_trailing_slash_on_endpoint_handled(self, monkeypatch):
        """Endpoint with trailing slash should not produce double-slash in URL."""
        monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://myres.services.ai.azure.com/")
        monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "k")

        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mod

        monkeypatch.setattr(mod, "_HAS_REQUESTS", True)

        captured = {}

        def fake_post(url, **kw):
            captured["url"] = url

            class R:
                status_code = 200
                def json(self): return {"choices": [{"message": {"content": "x"}}]}

            return R()

        monkeypatch.setattr(mod._requests, "post", fake_post)
        mod.extract_text_from_url("https://img.xhs.com/a.jpg")

        assert "//" not in captured["url"].replace("https://", "")


# --- Graceful degradation ---


class TestMistralGracefulDegradation:
    def test_extract_returns_none_on_http_error(self, monkeypatch):
        monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://x.services.ai.azure.com")
        monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "key")
        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mod

        monkeypatch.setattr(mod, "_HAS_REQUESTS", True)

        class FakeResp:
            status_code = 500
            text = "Internal Server Error"

        monkeypatch.setattr(mod._requests, "post", lambda **kw: FakeResp())
        monkeypatch.setattr(mod._requests, "post", lambda *a, **kw: FakeResp())

        result = mod.extract_text_from_url("https://img.xhs.com/pic.jpg")
        assert result is None

    def test_extract_returns_none_on_exception(self, monkeypatch):
        monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://x.services.ai.azure.com")
        monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "key")
        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mod

        monkeypatch.setattr(mod, "_HAS_REQUESTS", True)
        monkeypatch.setattr(mod._requests, "post", lambda *a, **kw: (_ for _ in ()).throw(ConnectionError("timeout")))

        result = mod.extract_text_from_url("https://img.xhs.com/pic.jpg")
        assert result is None

    def test_extract_urls_warns_on_missing_config(self, monkeypatch):
        monkeypatch.delenv("AZURE_FOUNDRY_ENDPOINT", raising=False)
        monkeypatch.delenv("AZURE_FOUNDRY_API_KEY", raising=False)
        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mod

        monkeypatch.setattr(mod, "_HAS_REQUESTS", True)

        texts, warnings = mod.extract_text_from_urls(["https://img.xhs.com/a.jpg"])
        assert texts == []
        assert any("AZURE_FOUNDRY_ENDPOINT" in w for w in warnings)


# --- Fallback from mistral when unconfigured ---


class TestProviderFallback:
    def test_mistral_skips_when_unconfigured(self, monkeypatch):
        """When OCR_PROVIDER=mistral but config is missing, skips with clear warning."""
        monkeypatch.setenv("OCR_PROVIDER", "mistral")
        monkeypatch.delenv("AZURE_FOUNDRY_ENDPOINT", raising=False)
        monkeypatch.delenv("AZURE_FOUNDRY_API_KEY", raising=False)

        import content_analyzer.adapters.xiaohongshu.ocr as ocr_mod
        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mistral_mod

        monkeypatch.setattr(mistral_mod, "_HAS_REQUESTS", True)

        texts, warnings, _, _ = ocr_mod.extract_text_from_urls(["https://img.xhs.com/a.jpg"])
        assert texts == []
        assert any("Mistral OCR not configured" in w for w in warnings)

    def test_mistral_provider_routes_correctly(self, monkeypatch):
        """When OCR_PROVIDER=mistral and config is present, uses mistral."""
        monkeypatch.setenv("OCR_PROVIDER", "mistral")
        monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://x.services.ai.azure.com")
        monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "key")

        import content_analyzer.adapters.xiaohongshu.ocr as ocr_mod
        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mistral_mod

        monkeypatch.setattr(mistral_mod, "_HAS_REQUESTS", True)

        class FakeResp:
            status_code = 200

            def json(self):
                return {"choices": [{"message": {"content": "Mistral extracted"}}]}

        monkeypatch.setattr(mistral_mod._requests, "post", lambda *a, **kw: FakeResp())

        texts, warnings, _, _ = ocr_mod.extract_text_from_urls(["https://img.xhs.com/a.jpg"])
        assert texts == ["Mistral extracted"]
        assert warnings == []


# --- Merge behavior in fetcher ---


class TestMistralMergeInFetcher:
    def test_fetch_note_uses_mistral_ocr(self, monkeypatch):
        """End-to-end: fetch_note uses Mistral OCR when configured."""
        monkeypatch.setenv("OCR_PROVIDER", "mistral")
        monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://x.services.ai.azure.com")
        monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "key")

        import content_analyzer.adapters.xiaohongshu.fetcher as fetcher_mod
        import content_analyzer.adapters.xiaohongshu.mistral_ocr as mistral_mod

        monkeypatch.setattr(fetcher_mod, "_HAS_REQUESTS", True)
        monkeypatch.setattr(mistral_mod, "_HAS_REQUESTS", True)

        class FakePageResp:
            status_code = 200
            url = "https://www.xiaohongshu.com/explore/abc123"
            text = (
                '<html><script>window.__INITIAL_STATE__='
                '{"note":{"noteDetailMap":{"abc123":{"note":{'
                '"title":"Test Note","desc":"Some caption",'
                '"user":{"nickname":"Author"},'
                '"interactInfo":{},'
                '"imageList":[{"urlDefault":"https://img.xhs.com/pic1.jpg"}]'
                '}}}}}</script></html>'
            )

        import requests as req_mod

        monkeypatch.setattr(req_mod, "get", lambda *a, **kw: FakePageResp())

        class FakeOcrResp:
            status_code = 200

            def json(self):
                return {"choices": [{"message": {"content": "Mistral OCR text"}}]}

        monkeypatch.setattr(mistral_mod._requests, "post", lambda *a, **kw: FakeOcrResp())

        meta, text, warnings, _, _ = fetcher_mod.fetch_note(
            "https://www.xiaohongshu.com/explore/abc123"
        )
        assert "Some caption" in text
        assert "[OCR]" in text
        assert "Mistral OCR text" in text
