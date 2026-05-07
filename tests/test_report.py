"""Tests for Markdown report rendering and CLI --format wiring."""
import json
from typer.testing import CliRunner
from content_analyzer.models import AnalysisResult, Metadata, TranscriptSegment
from content_analyzer.report import render_markdown
from content_analyzer.cli import app

runner = CliRunner()


def _make_result(**kwargs):
    defaults = dict(
        metadata=Metadata(video_id="abc123", title="5 Tips for Better Content", channel="CreatorX", view_count=12000),
        transcript=[TranscriptSegment(start=0, duration=10, text="subscribe for more tips on content creation")],
        hook="Did you know most creators fail in the first month?",
        structure=["Intro", "Tip 1-3", "Tip 4-5", "CTA"],
        takeaways=["Consistency beats perfection", "Hook in first 3 seconds"],
        reusable_angles=["Numbered tips format", "Personal failure story opener"],
        keywords=["content", "creator", "tips", "subscribe"],
        content_style="listicle",
        audience_intent="learn/build skill",
        engagement_hooks=["listicle/number", "question"],
        cta_signals=["subscribe"],
        warnings=[],
    )
    defaults.update(kwargs)
    return AnalysisResult(**defaults)


class TestRenderMarkdown:
    def test_contains_title(self):
        r = _make_result()
        md = render_markdown(r)
        assert "# Teardown: 5 Tips for Better Content" in md

    def test_contains_summary_fields(self):
        r = _make_result()
        md = render_markdown(r)
        assert "**Channel/Author:** CreatorX" in md
        assert "**Views:** 12,000" in md
        assert "**Style:** listicle" in md

    def test_contains_hook_section(self):
        r = _make_result()
        md = render_markdown(r)
        assert "## Hook" in md
        assert "> Did you know most creators fail" in md

    def test_contains_structure(self):
        r = _make_result()
        md = render_markdown(r)
        assert "## Structure" in md
        assert "1. Intro" in md

    def test_contains_keywords(self):
        r = _make_result()
        md = render_markdown(r)
        assert "## Keywords" in md
        assert "content" in md

    def test_contains_engagement_hooks(self):
        r = _make_result()
        md = render_markdown(r)
        assert "## Engagement Hooks" in md
        assert "- listicle/number" in md

    def test_contains_cta_signals(self):
        r = _make_result()
        md = render_markdown(r)
        assert "## CTA Signals" in md
        assert "- subscribe" in md

    def test_contains_reusable_angles(self):
        r = _make_result()
        md = render_markdown(r)
        assert "## Reusable Angles" in md

    def test_contains_why_it_works(self):
        r = _make_result()
        md = render_markdown(r)
        assert "## Why It Works" in md
        assert "proven format" in md

    def test_warnings_shown_when_present(self):
        r = _make_result(warnings=["Transcript unavailable"])
        md = render_markdown(r)
        assert "⚠️ Warnings" in md
        assert "Transcript unavailable" in md

    def test_minimal_result_does_not_crash(self):
        r = AnalysisResult(metadata=Metadata(video_id="empty"))
        md = render_markdown(r)
        assert "# Teardown:" in md
        assert "Insufficient data" in md

    def test_xiaohongshu_result_renders(self):
        """Xiaohongshu-style result (no duration, no channel) renders cleanly."""
        r = _make_result(
            metadata=Metadata(video_id="xhs_note", title="小红书爆款笔记拆解"),
            keywords=["小红书", "爆款", "笔记"],
            cta_signals=["点赞", "收藏", "关注"],
        )
        md = render_markdown(r)
        assert "小红书爆款笔记拆解" in md
        assert "点赞" in md


class TestCLIFormat:
    def test_default_format_is_json(self, monkeypatch):
        """Default output is valid JSON (mock the pipeline)."""
        import content_analyzer.cli as cli_mod
        monkeypatch.setattr(cli_mod, "analyze_youtube", lambda url: _make_result())
        result = runner.invoke(app, ["https://youtube.com/watch?v=test"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert "metadata" in data

    def test_markdown_format(self, monkeypatch):
        """--format markdown produces Markdown output."""
        import content_analyzer.cli as cli_mod
        monkeypatch.setattr(cli_mod, "analyze_youtube", lambda url: _make_result())
        result = runner.invoke(app, ["https://youtube.com/watch?v=test", "--format", "markdown"])
        assert result.exit_code == 0
        assert "# Teardown:" in result.output
        assert "## Hook" in result.output

    def test_md_shorthand(self, monkeypatch):
        """--format md also works."""
        import content_analyzer.cli as cli_mod
        monkeypatch.setattr(cli_mod, "analyze_youtube", lambda url: _make_result())
        result = runner.invoke(app, ["https://youtube.com/watch?v=test", "-f", "md"])
        assert result.exit_code == 0
        assert "# Teardown:" in result.output
