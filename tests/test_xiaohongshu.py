"""Offline tests for Xiaohongshu adapter."""
import json
from content_analyzer.adapters.xiaohongshu.url import is_xiaohongshu_url, extract_note_id
from content_analyzer.adapters.xiaohongshu.fetcher import _extract_initial_state
from content_analyzer import pipeline
from content_analyzer.models import AnalysisResult, Metadata, TranscriptSegment


# --- URL routing tests ---


def test_is_xhs_url_explore():
    assert is_xiaohongshu_url("https://www.xiaohongshu.com/explore/6654a3c8000000001e00a5f1")


def test_is_xhs_url_short():
    assert is_xiaohongshu_url("https://xhslink.com/abc123")


def test_is_not_xhs_url():
    assert not is_xiaohongshu_url("https://www.youtube.com/watch?v=abc")
    assert not is_xiaohongshu_url("https://example.com")


def test_extract_note_id_explore():
    assert extract_note_id("https://www.xiaohongshu.com/explore/6654a3c8000000001e00a5f1") == "6654a3c8000000001e00a5f1"


def test_extract_note_id_discovery():
    assert extract_note_id("https://www.xiaohongshu.com/discovery/item/6654a3c8000000001e00a5f1") == "6654a3c8000000001e00a5f1"


def test_extract_note_id_short_link_returns_none():
    assert extract_note_id("https://xhslink.com/abc123") is None


# --- HTML parsing tests ---


def test_extract_initial_state_valid():
    html = '''<html><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc":{"note":{"title":"Hello","desc":"World","user":{"nickname":"Author"},"interactInfo":{"likedCount":"42"}}}}}}</script></html>'''
    state = _extract_initial_state(html)
    assert state is not None
    assert state["note"]["noteDetailMap"]["abc"]["note"]["title"] == "Hello"


def test_extract_initial_state_with_undefined():
    html = '''<html><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc":{"note":{"title":"Test","desc":undefined}}}}}</script></html>'''
    state = _extract_initial_state(html)
    assert state is not None
    assert state["note"]["noteDetailMap"]["abc"]["note"]["desc"] is None


def test_extract_initial_state_missing():
    html = "<html><body>No state here</body></html>"
    assert _extract_initial_state(html) is None


# --- Pipeline integration (mocked) ---


def test_analyze_xiaohongshu_graceful_no_requests(monkeypatch):
    """When requests is unavailable, pipeline returns warnings."""
    import content_analyzer.adapters.xiaohongshu.fetcher as fetcher_mod
    monkeypatch.setattr(fetcher_mod, "_HAS_REQUESTS", False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    result = pipeline.analyze_xiaohongshu("https://www.xiaohongshu.com/explore/abc123")
    assert any("requests" in w for w in result.warnings)
    assert result.metadata.video_id is not None


def test_analyze_xiaohongshu_with_mocked_content(monkeypatch):
    """Pipeline produces analysis when content is available."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    from content_analyzer.adapters import xiaohongshu_adapter

    def mock_fetch(url):
        meta = Metadata(video_id="abc123", title="测试笔记", channel="TestUser")
        return meta, "这是一篇关于旅行的笔记内容", [], 0, 0

    # Disable xhs-cli so it falls through to built-in fetcher
    monkeypatch.setattr(xiaohongshu_adapter, "_xhs_cli_available", lambda: False)
    monkeypatch.setattr(xiaohongshu_adapter, "fetch_note", mock_fetch)

    result = pipeline.analyze_xiaohongshu("https://www.xiaohongshu.com/explore/abc123")
    assert result.metadata.title == "测试笔记"
    assert result.transcript is not None
    assert result.hook is not None
    assert result.warnings == []


def test_analyze_xiaohongshu_blocked_page(monkeypatch):
    """Pipeline surfaces warnings when page is blocked."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    from content_analyzer.adapters import xiaohongshu_adapter

    def mock_fetch(url):
        meta = Metadata(video_id="abc123", title=None)
        return meta, None, ["Xiaohongshu returned a login/captcha wall."], 0, 0

    monkeypatch.setattr(xiaohongshu_adapter, "_xhs_cli_available", lambda: False)
    monkeypatch.setattr(xiaohongshu_adapter, "fetch_note", mock_fetch)

    result = pipeline.analyze_xiaohongshu("https://www.xiaohongshu.com/explore/abc123")
    assert any("login" in w or "captcha" in w for w in result.warnings)
    assert any("No text content" in w for w in result.warnings)


def test_cli_routes_xhs_url(monkeypatch):
    """CLI routes Xiaohongshu URLs to the correct pipeline."""
    from typer.testing import CliRunner
    from content_analyzer.cli import app
    from content_analyzer.adapters import xiaohongshu_adapter

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    def mock_fetch(url):
        meta = Metadata(video_id="note1", title="CLI Test")
        return meta, "Content text", [], 0, 0

    monkeypatch.setattr(xiaohongshu_adapter, "_xhs_cli_available", lambda: False)
    monkeypatch.setattr(xiaohongshu_adapter, "fetch_note", mock_fetch)

    runner = CliRunner()
    result = runner.invoke(app, ["analyze", "https://www.xiaohongshu.com/explore/note1"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["metadata"]["video_id"] == "note1"
    assert data["metadata"]["title"] == "CLI Test"
