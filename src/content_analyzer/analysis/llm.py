"""LLM-enhanced deep content analyzer. Requires OPENAI_API_KEY."""
from __future__ import annotations
import json
from content_analyzer.analysis.base import Analyzer
from content_analyzer.analysis.heuristic import HeuristicAnalyzer
from content_analyzer.config import Settings
from content_analyzer.models import AnalysisResult


class LLMAnalyzer(Analyzer):
    """Uses LLM to produce deep, structured content analysis."""

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
                messages=[
                    {"role": "system", "content": self._system_prompt()},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.3,
            )
            content = resp.choices[0].message.content or ""
            if resp.usage:
                result.token_usage.analysis_prompt_tokens = resp.usage.prompt_tokens or 0
                result.token_usage.analysis_completion_tokens = resp.usage.completion_tokens or 0
            self._parse_response(content, result)
        except Exception as e:
            result.warnings.append(f"LLM analysis failed ({e}); using heuristic fallback.")
            return self._fallback.analyze(result)
        return result

    def _system_prompt(self) -> str:
        return """You are a professional content analyst specializing in social media content strategy.
Your job is to deeply analyze content from platforms like Xiaohongshu (小红书) and YouTube.

You must:
1. FULLY extract and summarize the original content — don't skip anything important
2. Identify the structural pattern and why it works
3. Extract specific data points, claims, and evidence
4. Provide actionable insights for content creators who want to learn from this

Output ONLY valid JSON (no markdown fences, no explanation outside JSON)."""

    def _build_prompt(self, r: AnalysisResult) -> str:
        parts = []

        # Metadata context
        parts.append(f"=== CONTENT TO ANALYZE ===")
        parts.append(f"Title: {r.metadata.title or 'N/A'}")
        if r.metadata.channel:
            parts.append(f"Author: {r.metadata.channel}")
        if r.metadata.view_count:
            parts.append(f"Engagement: {r.metadata.view_count} likes/views")

        # Full content text
        if r.transcript:
            text = " ".join(seg.text for seg in r.transcript)
            # Give the LLM as much content as possible (up to 4000 chars)
            parts.append(f"\nFull Content:\n{text[:4000]}")

        # Image analysis if available
        if r.image_analysis:
            img = r.image_analysis
            if img.get("title"):
                parts.append(f"\nImage Title: {img['title']}")
            if img.get("headings"):
                parts.append(f"Image Headings: {', '.join(img['headings'])}")
            if img.get("key_claims"):
                parts.append(f"Key Claims from Images: {'; '.join(img['key_claims'])}")
            if img.get("stats"):
                parts.append(f"Stats from Images: {'; '.join(img['stats'])}")

        # Comments for audience signal
        if r.comments:
            top = sorted(r.comments, key=lambda c: c.likes, reverse=True)[:5]
            parts.append(f"\nTop Comments: {' | '.join(c.text for c in top)}")

        parts.append("""
=== ANALYSIS REQUIRED ===
Return a JSON object with ALL of these fields (provide substantive content for each):

{
  "summary": "2-3 sentence comprehensive summary of what this content covers and its core message",
  "hook": "The opening hook or attention-grabbing element (quote the actual text if possible)",
  "key_points": ["5-8 core arguments, claims, or teaching points from the content — be specific, not generic"],
  "data_points": ["Specific numbers, statistics, facts, or evidence mentioned in the content"],
  "structure": ["Step-by-step breakdown of how the content is organized (e.g., 'Problem statement', 'Solution 1: ...', 'Case study', 'CTA')"],
  "content_breakdown": [
    {"section": "Section name", "points": ["Key point 1", "Key point 2"]},
    {"section": "Next section", "points": ["..."]}
  ],
  "keywords": ["8-12 topic keywords that capture the content's themes"],
  "content_style": "Specific format (e.g., 'step-by-step tutorial', 'data-driven explainer', 'personal story + lessons', 'product comparison')",
  "target_audience": "Specific description of who this content is for (demographics, skill level, goals)",
  "audience_intent": "What the audience wants to get from this (be specific)",
  "unique_angle": "What makes this content different from others on the same topic",
  "engagement_hooks": ["Specific techniques used to grab and retain attention"],
  "cta_signals": ["Calls to action found in the content (or '无明显CTA' if none)"],
  "takeaways": ["3-5 actionable takeaways a viewer would remember"],
  "reusable_angles": ["Angles or framings that could be adapted to other topics"],
  "adaptation_ideas": ["3-5 specific, actionable ideas for how a creator could make similar content in their own niche"]
}""")
        return "\n".join(parts)

    def _parse_response(self, content: str, result: AnalysisResult) -> None:
        # Strip markdown fences if present
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[1] if "\n" in content else content[3:]
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()

        data = json.loads(content)
        result.summary = data.get("summary")
        result.hook = data.get("hook")
        result.key_points = data.get("key_points")
        result.data_points = data.get("data_points")
        result.structure = data.get("structure")
        result.content_breakdown = data.get("content_breakdown")
        result.keywords = data.get("keywords")
        result.content_style = data.get("content_style")
        result.target_audience = data.get("target_audience")
        result.audience_intent = data.get("audience_intent")
        result.unique_angle = data.get("unique_angle")
        result.engagement_hooks = data.get("engagement_hooks")
        result.cta_signals = data.get("cta_signals")
        result.takeaways = data.get("takeaways")
        result.reusable_angles = data.get("reusable_angles")
        result.adaptation_ideas = data.get("adaptation_ideas")
