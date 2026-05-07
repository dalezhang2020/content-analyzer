"""Tests for improved content_style classification, CTA cleanup, and adaptation_ideas."""
from content_analyzer.analysis.heuristic import HeuristicAnalyzer, _clean_cta_list
from content_analyzer.models import AnalysisResult, Metadata, TranscriptSegment
from content_analyzer.report import render_markdown


def _make(title=None, transcript_text=None, image_analysis=None):
    segs = None
    if transcript_text:
        segs = [TranscriptSegment(start=0, duration=0, text=transcript_text)]
    return AnalysisResult(
        metadata=Metadata(video_id="test", title=title),
        transcript=segs,
        image_analysis=image_analysis,
    )


# --- Content style: XHS-specific classifications ---


class TestXHSContentStyle:
    def test_industry_teardown(self):
        r = _make(title="拆解瑞幸咖啡的商业模式")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "industry teardown"

    def test_industry_teardown_deep_analysis(self):
        r = _make(title="深度分析小红书赛道背后的逻辑")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "industry teardown"

    def test_roundup(self):
        r = _make(title="2024年必备工具合集盘点")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "roundup"

    def test_roundup_number_pattern(self):
        r = _make(title="8款平价好用的面霜推荐")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "roundup"

    def test_tutorial_chinese(self):
        r = _make(title="手把手教你零基础做自媒体")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "tutorial"

    def test_review_chinese(self):
        r = _make(title="iPhone 16 Pro开箱测评体验")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "review"

    def test_explainer(self):
        r = _make(title="一文看懂什么是量化交易")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "explainer"

    def test_commentary(self):
        r = _make(title="关于最近争议的一些看法和观点")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "commentary"

    def test_english_styles_still_work(self):
        """Backward compat: English patterns still match."""
        r = _make(title="10 Tips to Improve Your Code")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "listicle"

    def test_english_tutorial_still_works(self):
        r = _make(title="How to Build a REST API Step by Step")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "tutorial/how-to"


# --- CTA cleanup ---


class TestCTACleanup:
    def test_filters_na(self):
        assert _clean_cta_list(["n/a"]) == []

    def test_filters_none_visible(self):
        assert _clean_cta_list(["None visible", "(None visible)"]) == []

    def test_filters_no_obvious_cta(self):
        assert _clean_cta_list(["No obvious CTA"]) == []

    def test_filters_not_applicable(self):
        assert _clean_cta_list(["Not applicable"]) == []

    def test_keeps_real_ctas(self):
        assert _clean_cta_list(["关注", "n/a", "点赞收藏"]) == ["关注", "点赞收藏"]

    def test_filters_dash_placeholder(self):
        assert _clean_cta_list(["—", "-", "–"]) == []

    def test_empty_strings_filtered(self):
        assert _clean_cta_list(["", "  ", "subscribe"]) == ["subscribe"]

    def test_image_cta_cleaned_in_analyzer(self):
        """Analyzer filters placeholder CTAs from image_analysis."""
        r = _make(
            title="Test",
            image_analysis={"cta": ["n/a", "None visible", "关注我"]},
        )
        result = HeuristicAnalyzer().analyze(r)
        assert result.cta_signals == ["关注我"]

    def test_all_placeholder_ctas_fall_through_to_text(self):
        """When all image CTAs are placeholders, fall through to text-based detection."""
        r = _make(
            title="Test",
            transcript_text="记得点赞关注",
            image_analysis={"cta": ["n/a", "None visible"]},
        )
        result = HeuristicAnalyzer().analyze(r)
        assert result.cta_signals is not None
        assert any(s in result.cta_signals for s in ["点赞", "关注"])


# --- Adaptation ideas ---


class TestAdaptationIdeas:
    def test_generates_ideas_for_teardown(self):
        r = _make(title="拆解某品牌的增长策略")
        result = HeuristicAnalyzer().analyze(r)
        assert result.adaptation_ideas is not None
        assert any("brand" in idea or "niche" in idea for idea in result.adaptation_ideas)

    def test_generates_ideas_for_listicle(self):
        r = _make(title="10 Tips to Save Money")
        result = HeuristicAnalyzer().analyze(r)
        assert result.adaptation_ideas is not None
        assert any("tip" in idea.lower() or "list" in idea.lower() for idea in result.adaptation_ideas)

    def test_includes_structure_mirror(self):
        """When structure has 3+ items, adaptation includes a structure mirror suggestion."""
        r = AnalysisResult(
            metadata=Metadata(video_id="test", title="Guide"),
            transcript=[
                TranscriptSegment(start=0, duration=5, text="Intro segment"),
                TranscriptSegment(start=5, duration=5, text="Problem statement"),
                TranscriptSegment(start=10, duration=5, text="Solution details"),
                TranscriptSegment(start=15, duration=5, text="Call to action ending"),
            ],
        )
        result = HeuristicAnalyzer().analyze(r)
        assert result.structure is not None and len(result.structure) >= 3
        assert result.adaptation_ideas is not None
        assert any("structure" in idea.lower() or "→" in idea for idea in result.adaptation_ideas)

    def test_includes_hook_suggestion(self):
        r = _make(title="Why most startups fail?", transcript_text="Let me tell you a story")
        result = HeuristicAnalyzer().analyze(r)
        assert result.adaptation_ideas is not None
        assert any("hook" in idea.lower() for idea in result.adaptation_ideas)

    def test_none_when_no_data(self):
        r = AnalysisResult(metadata=Metadata(video_id="empty"))
        result = HeuristicAnalyzer().analyze(r)
        assert result.adaptation_ideas is None

    def test_adaptation_in_report(self):
        """Adaptation ideas render in markdown report."""
        r = _make(title="拆解某品牌的增长策略", transcript_text="这个品牌的底层逻辑")
        result = HeuristicAnalyzer().analyze(r)
        md = render_markdown(result)
        assert "## How to Adapt This" in md

    def test_adaptation_in_json(self):
        """adaptation_ideas serializes in JSON output."""
        import json
        r = _make(title="10 Tips to Learn Fast")
        result = HeuristicAnalyzer().analyze(r)
        data = json.loads(result.model_dump_json())
        assert "adaptation_ideas" in data
