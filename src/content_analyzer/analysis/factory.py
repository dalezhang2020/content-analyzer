"""Factory to select the best available analyzer."""
from __future__ import annotations
from content_analyzer.analysis.base import Analyzer
from content_analyzer.config import Settings


def get_analyzer() -> Analyzer:
    """Return LLMAnalyzer if OPENAI_API_KEY is set, else HeuristicAnalyzer."""
    if Settings.load().openai_api_key:
        from content_analyzer.analysis.llm import LLMAnalyzer
        return LLMAnalyzer()
    from content_analyzer.analysis.heuristic import HeuristicAnalyzer
    return HeuristicAnalyzer()
