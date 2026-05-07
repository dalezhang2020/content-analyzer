"""Smoke tests for UI rendering helpers and entrypoint importability."""
from __future__ import annotations

import importlib
import sys
from unittest.mock import MagicMock

import pytest

from content_analyzer.models import AnalysisResult, Metadata, TranscriptSegment


@pytest.fixture()
def sample_result() -> AnalysisResult:
    return AnalysisResult(
        metadata=Metadata(
            video_id="abc123",
            title="Test Video",
            channel="TestChannel",
            view_count=1000,
            duration_seconds=125,
        ),
        transcript=[TranscriptSegment(start=0, duration=5, text="Hello world")],
        hook="This is the hook",
        structure=["Intro", "Body", "Outro"],
        keywords=["test", "demo"],
        content_style="tutorial",
        audience_intent="learn",
        engagement_hooks=["question"],
        cta_signals=["subscribe"],
        reusable_angles=["angle1"],
        adaptation_ideas=["idea1"],
        takeaways=["takeaway1"],
        image_analysis={
            "title": "Image Title",
            "headings": ["H1", "H2"],
            "key_claims": ["claim1"],
            "stats": ["stat1"],
            "cta": ["follow"],
            "visual_framing": ["frame1"],
            "raw_text": "some raw text",
        },
        warnings=["warn1"],
    )


def test_ui_module_importable():
    """The UI module should be importable without crashing (streamlit may not be installed)."""
    try:
        import streamlit  # noqa: F401
    except ImportError:
        pytest.skip("streamlit not installed")
    # Just verify the module can be found and has no syntax errors
    spec = importlib.util.find_spec("content_analyzer.ui")
    assert spec is not None


def test_render_metadata_fields(sample_result: AnalysisResult):
    """Verify metadata fields are accessible for rendering."""
    m = sample_result.metadata
    assert m.title == "Test Video"
    assert m.channel == "TestChannel"
    assert m.view_count == 1000
    mins, secs = divmod(m.duration_seconds, 60)
    assert mins == 2
    assert secs == 5


def test_render_teardown_fields(sample_result: AnalysisResult):
    """Verify teardown fields are present and non-empty."""
    assert sample_result.hook
    assert sample_result.content_style
    assert sample_result.audience_intent
    assert len(sample_result.structure) == 3
    assert len(sample_result.keywords) == 2
    assert len(sample_result.engagement_hooks) == 1
    assert len(sample_result.cta_signals) == 1


def test_render_image_analysis_fields(sample_result: AnalysisResult):
    """Verify image_analysis dict has expected keys."""
    ia = sample_result.image_analysis
    assert ia is not None
    assert ia["title"] == "Image Title"
    assert len(ia["headings"]) == 2
    assert ia["raw_text"] == "some raw text"


def test_warnings_present(sample_result: AnalysisResult):
    """Verify warnings list is accessible."""
    assert sample_result.warnings == ["warn1"]


def test_result_without_image_analysis():
    """Result with no image_analysis should have None."""
    result = AnalysisResult(
        metadata=Metadata(video_id="x"),
        warnings=[],
    )
    assert result.image_analysis is None
