"""Smoke tests for core logic (no network)."""
import json
import os
from content_analyzer import pipeline
from content_analyzer.adapters.youtube.metadata import extract_video_id
from content_analyzer.analysis.heuristic import HeuristicAnalyzer
from content_analyzer.analysis.factory import get_analyzer
from content_analyzer.models import AnalysisResult, Metadata, TranscriptSegment, Comment


def test_extract_video_id_standard():
    assert extract_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "dQw4w9WgXcQ"


def test_extract_video_id_short():
    assert extract_video_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"


def test_extract_video_id_shorts():
    assert extract_video_id("https://www.youtube.com/shorts/dQw4w9WgXcQ") == "dQw4w9WgXcQ"


def test_analysis_result_serializes():
    r = AnalysisResult(metadata=Metadata(video_id="abc123"))
    data = json.loads(r.model_dump_json())
    assert data["metadata"]["video_id"] == "abc123"
    assert data["transcript"] is None
    assert data["hook"] is None
    assert data["warnings"] == []


def test_pipeline_emits_warnings_for_missing_optional_sources(monkeypatch):
    from content_analyzer.adapters import youtube_adapter

    monkeypatch.setattr(youtube_adapter, "fetch_metadata", lambda url: Metadata(video_id="abc123"))
    monkeypatch.setattr(youtube_adapter, "extract_video_id", lambda url: "abc123")
    monkeypatch.setattr(youtube_adapter, "fetch_transcript", lambda video_id: None)
    monkeypatch.setattr(youtube_adapter, "fetch_comments", lambda video_id, max_results=20: None)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    result = pipeline.analyze_youtube("https://youtu.be/dQw4w9WgXcQ")

    assert result.metadata.video_id == "abc123"
    # 3 data warnings expected
    assert any("Metadata" in w for w in result.warnings)
    assert any("Transcript" in w for w in result.warnings)
    assert any("Comments" in w for w in result.warnings)


# --- Analysis tests ---


def test_heuristic_with_transcript_only():
    segs = [
        TranscriptSegment(start=0, duration=5, text="Welcome to the show"),
        TranscriptSegment(start=5, duration=5, text="Today we discuss AI"),
        TranscriptSegment(start=10, duration=5, text="Let's dive in"),
        TranscriptSegment(start=15, duration=5, text="First point"),
        TranscriptSegment(start=20, duration=5, text="Second point"),
        TranscriptSegment(start=25, duration=5, text="Third point"),
        TranscriptSegment(start=30, duration=5, text="Fourth point"),
        TranscriptSegment(start=35, duration=5, text="Conclusion"),
    ]
    r = AnalysisResult(metadata=Metadata(video_id="t1", title="AI Talk"), transcript=segs)
    analyzer = HeuristicAnalyzer()
    result = analyzer.analyze(r)

    assert result.hook is not None
    assert "Welcome" in result.hook
    assert result.structure is not None
    assert len(result.structure) == 4  # quartile sections
    assert result.takeaways is not None
    assert result.reusable_angles is not None


def test_heuristic_with_metadata_only():
    r = AnalysisResult(metadata=Metadata(video_id="t2", title="Great Video", view_count=500_000))
    analyzer = HeuristicAnalyzer()
    result = analyzer.analyze(r)

    assert result.hook == "Great Video"
    assert result.structure == ["Great Video"]
    assert result.reusable_angles is not None
    assert any("High-view-count" in a for a in result.reusable_angles)


def test_heuristic_with_comments():
    comments = [
        Comment(text="This changed my life!", likes=100),
        Comment(text="How do I start?", likes=50),
        Comment(text="Meh", likes=1),
    ]
    r = AnalysisResult(
        metadata=Metadata(video_id="t3", title="Tips"),
        comments=comments,
    )
    analyzer = HeuristicAnalyzer()
    result = analyzer.analyze(r)

    assert result.takeaways is not None
    assert "This changed my life!" in result.takeaways
    assert result.reusable_angles is not None
    assert any("question" in a.lower() for a in result.reusable_angles)


def test_factory_returns_heuristic_without_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    analyzer = get_analyzer()
    assert type(analyzer).__name__ == "HeuristicAnalyzer"


def test_factory_returns_llm_with_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    analyzer = get_analyzer()
    assert type(analyzer).__name__ == "LLMAnalyzer"


def test_pipeline_fills_analysis_fields(monkeypatch):
    """Full pipeline with mocked adapters produces analysis fields."""
    from content_analyzer.adapters import youtube_adapter

    segs = [
        TranscriptSegment(start=0, duration=3, text="Hey everyone"),
        TranscriptSegment(start=3, duration=3, text="Today we learn Python"),
        TranscriptSegment(start=6, duration=3, text="Let's go"),
        TranscriptSegment(start=9, duration=3, text="Tip one"),
        TranscriptSegment(start=12, duration=3, text="Tip two"),
        TranscriptSegment(start=15, duration=3, text="Wrap up"),
    ]
    comments = [Comment(text="Great video!", likes=10)]

    monkeypatch.setattr(youtube_adapter, "fetch_metadata", lambda url: Metadata(video_id="x", title="Learn Python"))
    monkeypatch.setattr(youtube_adapter, "extract_video_id", lambda url: "x")
    monkeypatch.setattr(youtube_adapter, "fetch_transcript", lambda vid: segs)
    monkeypatch.setattr(youtube_adapter, "fetch_comments", lambda vid, max_results=20: comments)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    result = pipeline.analyze_youtube("https://youtu.be/x")

    assert result.hook is not None
    assert result.structure is not None
    assert result.takeaways is not None
    assert result.reusable_angles is not None
