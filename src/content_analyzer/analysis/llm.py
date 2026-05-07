"""Optional LLM-enhanced analyzer. Requires OPENAI_API_KEY."""
from __future__ import annotations
import json
from content_analyzer.analysis.base import Analyzer
from content_analyzer.analysis.heuristic import HeuristicAnalyzer
from content_analyzer.config import Settings
from content_analyzer.models import AnalysisResult


class LLMAnalyzer(Analyzer):
    """Uses OpenAI API to produce richer analysis; falls back to heuristic on failure."""

    def __init__(self) -> None:
        self._fallback = HeuristicAnalyzer()

    def analyze(self, result: AnalysisResult) -> AnalysisResult:
        try:
            import openai  # noqa: F401
        except ImportError:
            result.warnings.append(
                "openai package not installed; install the optional 'llm' extra to enable LLM analysis."
            )
            return self._fallback.analyze(result)

        runtime_settings = Settings.load()
        api_key = runtime_settings.openai_api_key
        if not api_key:
            result.warnings.append("OPENAI_API_KEY not set; using heuristic analysis.")
            return self._fallback.analyze(result)

        prompt = self._build_prompt(result)
        try:
            client = openai.OpenAI(api_key=api_key)
            resp = client.chat.completions.create(
                model=runtime_settings.openai_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
            )
            content = resp.choices[0].message.content or ""
            self._parse_response(content, result)
        except Exception as e:
            result.warnings.append(f"LLM analysis failed ({e}); using heuristic fallback.")
            return self._fallback.analyze(result)
        return result

    def _build_prompt(self, r: AnalysisResult) -> str:
        parts = [f"Title: {r.metadata.title or 'N/A'}"]
        if r.transcript:
            text = " ".join(seg.text for seg in r.transcript[:50])
            parts.append(f"Transcript (first 50 segments): {text[:2000]}")
        if r.comments:
            top = sorted(r.comments, key=lambda c: c.likes, reverse=True)[:5]
            parts.append("Top comments: " + " | ".join(c.text for c in top))
        parts.append(
            'Return JSON with keys: hook (string), structure (list of strings), '
            'takeaways (list of strings), reusable_angles (list of strings), '
            'keywords (list of strings – top topic keywords), '
            'content_style (string – e.g. listicle, tutorial, narrative, review, vlog, opinion, informational), '
            'audience_intent (string – what the viewer likely wants from this content), '
            'engagement_hooks (list of strings – techniques used to grab/retain attention), '
            'cta_signals (list of strings – calls to action found in the content), '
            'adaptation_ideas (list of strings – actionable suggestions for how to imitate this content pattern for your own account). '
            'No markdown fences.'
        )
        return "\n".join(parts)

    def _parse_response(self, content: str, result: AnalysisResult) -> None:
        data = json.loads(content)
        result.hook = data.get("hook")
        result.structure = data.get("structure")
        result.takeaways = data.get("takeaways")
        result.reusable_angles = data.get("reusable_angles")
        result.keywords = data.get("keywords")
        result.content_style = data.get("content_style")
        result.audience_intent = data.get("audience_intent")
        result.engagement_hooks = data.get("engagement_hooks")
        result.cta_signals = data.get("cta_signals")
        result.adaptation_ideas = data.get("adaptation_ideas")
