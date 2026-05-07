"""Abstract analyzer interface."""
from __future__ import annotations
from abc import ABC, abstractmethod
from content_analyzer.models import AnalysisResult


class Analyzer(ABC):
    @abstractmethod
    def analyze(self, result: AnalysisResult) -> AnalysisResult:
        """Fill hook, structure, takeaways, reusable_angles on result."""
        ...
