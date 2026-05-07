"""Tests for creator teardown fields in heuristic analyzer."""
from content_analyzer.analysis.heuristic import HeuristicAnalyzer
from content_analyzer.models import AnalysisResult, Metadata, TranscriptSegment, Comment


def _make_result(title=None, transcript_text=None, comments=None, view_count=None):
    segs = None
    if transcript_text:
        segs = [TranscriptSegment(start=0, duration=10, text=transcript_text)]
    return AnalysisResult(
        metadata=Metadata(video_id="test", title=title, view_count=view_count),
        transcript=segs,
        comments=comments,
    )


class TestKeywords:
    def test_extracts_keywords_from_transcript(self):
        r = _make_result(title="Python Tips", transcript_text="python is great python tutorial python basics learn python fast")
        result = HeuristicAnalyzer().analyze(r)
        assert result.keywords is not None
        assert "python" in result.keywords

    def test_returns_none_when_no_text(self):
        r = _make_result()
        result = HeuristicAnalyzer().analyze(r)
        assert result.keywords is None


class TestContentStyle:
    def test_detects_listicle(self):
        r = _make_result(title="10 Tips to Improve Your Code")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "listicle"

    def test_detects_tutorial(self):
        r = _make_result(title="How to Build a REST API Step by Step")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "tutorial/how-to"

    def test_detects_narrative(self):
        r = _make_result(title="My Journey Learning to Code")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "narrative/storytelling"

    def test_detects_review(self):
        r = _make_result(title="MacBook Pro vs Dell XPS Compared")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "review/comparison"

    def test_defaults_to_informational(self):
        r = _make_result(title="Understanding Quantum Physics")
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style == "informational"

    def test_returns_none_when_no_text(self):
        r = _make_result()
        result = HeuristicAnalyzer().analyze(r)
        assert result.content_style is None


class TestAudienceIntent:
    def test_detects_learning_intent(self):
        r = _make_result(title="How to Learn Python for Beginners")
        result = HeuristicAnalyzer().analyze(r)
        assert result.audience_intent is not None
        assert "learn" in result.audience_intent or "skill" in result.audience_intent

    def test_detects_evaluation_intent(self):
        r = _make_result(title="Should I Buy the New iPhone? Honest Review")
        result = HeuristicAnalyzer().analyze(r)
        assert "evaluate" in result.audience_intent or "decision" in result.audience_intent

    def test_detects_entertainment(self):
        r = _make_result(title="Funny Cat Compilation Laugh Out Loud")
        result = HeuristicAnalyzer().analyze(r)
        assert "entertainment" in result.audience_intent

    def test_returns_none_when_no_text(self):
        r = _make_result()
        result = HeuristicAnalyzer().analyze(r)
        assert result.audience_intent is None


class TestEngagementHooks:
    def test_detects_question(self):
        r = _make_result(title="Why do most startups fail?")
        result = HeuristicAnalyzer().analyze(r)
        assert result.engagement_hooks is not None
        assert "question" in result.engagement_hooks

    def test_detects_listicle_number(self):
        r = _make_result(title="5 Ways to Save Money")
        result = HeuristicAnalyzer().analyze(r)
        assert result.engagement_hooks is not None
        assert "listicle/number" in result.engagement_hooks

    def test_detects_negative_framing(self):
        r = _make_result(title="Mistakes You Should Never Make")
        result = HeuristicAnalyzer().analyze(r)
        assert result.engagement_hooks is not None
        assert "negative framing" in result.engagement_hooks

    def test_returns_none_when_no_hooks(self):
        r = _make_result(title="Update")
        result = HeuristicAnalyzer().analyze(r)
        # "Update" alone doesn't match any hook pattern
        assert result.engagement_hooks is None or len(result.engagement_hooks) == 0


class TestCtaSignals:
    def test_detects_subscribe_cta(self):
        r = _make_result(transcript_text="Don't forget to subscribe and click the bell")
        result = HeuristicAnalyzer().analyze(r)
        assert result.cta_signals is not None
        assert "subscribe" in result.cta_signals

    def test_detects_chinese_cta(self):
        r = _make_result(transcript_text="记得点赞收藏关注哦")
        result = HeuristicAnalyzer().analyze(r)
        assert result.cta_signals is not None
        assert any(s in result.cta_signals for s in ["点赞", "收藏", "关注"])

    def test_returns_none_when_no_cta(self):
        r = _make_result(title="Hello World", transcript_text="This is just a normal sentence about coding")
        result = HeuristicAnalyzer().analyze(r)
        assert result.cta_signals is None


class TestGracefulDegradation:
    def test_all_new_fields_none_with_empty_input(self):
        r = AnalysisResult(metadata=Metadata(video_id="empty"))
        result = HeuristicAnalyzer().analyze(r)
        assert result.keywords is None
        assert result.content_style is None
        assert result.audience_intent is None
        assert result.engagement_hooks is None
        assert result.cta_signals is None

    def test_new_fields_present_in_json_output(self):
        """New fields serialize correctly in JSON."""
        import json
        r = _make_result(title="5 Tips to Learn Python Fast", transcript_text="subscribe now for more tutorials")
        result = HeuristicAnalyzer().analyze(r)
        data = json.loads(result.model_dump_json())
        assert "keywords" in data
        assert "content_style" in data
        assert "audience_intent" in data
        assert "engagement_hooks" in data
        assert "cta_signals" in data
