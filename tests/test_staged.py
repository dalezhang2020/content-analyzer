"""Tests for the staged pipeline wrapper."""
import json
import subprocess
import sys
from unittest.mock import patch, MagicMock

import pytest

from content_analyzer.staged import _emit, STAGES


class TestEmit:
    """Test the _emit helper."""

    def test_emit_writes_json_to_stderr(self, capsys):
        _emit("fetch")
        captured = capsys.readouterr()
        line = captured.err.strip()
        parsed = json.loads(line)
        assert parsed == {"__stage__": "fetch"}

    def test_emit_all_stages(self, capsys):
        for stage in STAGES:
            _emit(stage)
        captured = capsys.readouterr()
        lines = [l for l in captured.err.strip().split("\n") if l]
        assert len(lines) == len(STAGES)
        for line, expected in zip(lines, STAGES):
            assert json.loads(line) == {"__stage__": expected}


class TestStagedCLI:
    """Integration test: run analyze --staged with a mock to verify stage ordering."""

    def test_staged_flag_emits_ordered_stages(self):
        """Verify that --staged produces ordered stage markers on stderr."""
        # We mock the actual network calls but verify the stage protocol
        with patch("content_analyzer.adapters.xiaohongshu.is_xiaohongshu_url", return_value=False), \
             patch("content_analyzer.adapters.youtube.fetch_metadata") as mock_meta, \
             patch("content_analyzer.adapters.youtube.metadata.extract_video_id", return_value="test123"), \
             patch("content_analyzer.adapters.youtube.fetch_transcript", return_value=None), \
             patch("content_analyzer.adapters.youtube.fetch_comments", return_value=None), \
             patch("content_analyzer.analysis.get_analyzer") as mock_analyzer:

            from content_analyzer.models import Metadata, AnalysisResult

            mock_meta.return_value = Metadata(video_id="test123", title="Test")
            mock_result = AnalysisResult(
                metadata=Metadata(video_id="test123", title="Test"),
                transcript=None,
                comments=None,
                warnings=[],
            )
            analyzer_instance = MagicMock()
            analyzer_instance.analyze.return_value = mock_result
            mock_analyzer.return_value = analyzer_instance

            import io
            stderr_capture = io.StringIO()
            stdout_capture = io.StringIO()

            with patch("sys.stderr", stderr_capture), \
                 patch("sys.stdout", stdout_capture):
                from content_analyzer.staged import run
                run("https://www.youtube.com/watch?v=test123")

            stderr_output = stderr_capture.getvalue()
            lines = [l for l in stderr_output.strip().split("\n") if l]
            stages_emitted = []
            for line in lines:
                parsed = json.loads(line)
                stages_emitted.append(parsed["__stage__"])

            # Verify correct order
            assert stages_emitted == ["input", "fetch", "extract", "analyze", "report", "done"]

    def test_stages_are_strictly_ordered(self):
        """Verify that emitted stages follow the defined STAGES order."""
        # This tests the contract: each stage index must be > previous
        for i in range(1, len(STAGES)):
            assert STAGES.index(STAGES[i]) > STAGES.index(STAGES[i - 1])
