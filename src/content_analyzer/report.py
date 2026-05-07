"""Render AnalysisResult as a creator-friendly Markdown teardown report."""
from __future__ import annotations

from content_analyzer.models import AnalysisResult


def render_markdown(result: AnalysisResult) -> str:
    """Return a Markdown string summarizing the analysis for creator review."""
    lines: list[str] = []
    m = result.metadata

    # Title
    title = m.title or m.video_id
    lines.append(f"# Teardown: {title}")
    lines.append("")

    # Summary block
    lines.append("## Summary")
    lines.append("")
    parts: list[str] = []
    if m.channel:
        parts.append(f"**Channel/Author:** {m.channel}")
    if m.publish_date:
        parts.append(f"**Published:** {m.publish_date}")
    if m.view_count is not None:
        parts.append(f"**Views:** {m.view_count:,}")
    if m.duration_seconds is not None:
        mins, secs = divmod(m.duration_seconds, 60)
        parts.append(f"**Duration:** {mins}m {secs}s")
    if result.content_style:
        parts.append(f"**Style:** {result.content_style}")
    if result.audience_intent:
        parts.append(f"**Audience intent:** {result.audience_intent}")
    lines.extend(parts)
    lines.append("")

    # Why it works
    lines.append("## Why It Works")
    lines.append("")
    _bullet_list(lines, _why_it_works(result))

    # Hook
    if result.hook:
        lines.append("## Hook")
        lines.append("")
        lines.append(f"> {result.hook}")
        lines.append("")

    # Structure
    if result.structure:
        lines.append("## Structure")
        lines.append("")
        for i, s in enumerate(result.structure, 1):
            lines.append(f"{i}. {s}")
        lines.append("")

    # Keywords
    if result.keywords:
        lines.append("## Keywords")
        lines.append("")
        lines.append(", ".join(result.keywords))
        lines.append("")

    # Engagement Hooks
    if result.engagement_hooks:
        lines.append("## Engagement Hooks")
        lines.append("")
        _bullet_list(lines, result.engagement_hooks)

    # CTA Signals
    if result.cta_signals:
        lines.append("## CTA Signals")
        lines.append("")
        _bullet_list(lines, result.cta_signals)

    # Reusable Angles
    if result.reusable_angles:
        lines.append("## Reusable Angles")
        lines.append("")
        _bullet_list(lines, result.reusable_angles)

    # Adaptation Ideas
    if result.adaptation_ideas:
        lines.append("## How to Adapt This")
        lines.append("")
        _bullet_list(lines, result.adaptation_ideas)

    # Takeaways
    if result.takeaways:
        lines.append("## Key Takeaways")
        lines.append("")
        _bullet_list(lines, result.takeaways)

    # Warnings
    if result.warnings:
        lines.append("## ⚠️ Warnings")
        lines.append("")
        _bullet_list(lines, result.warnings)

    return "\n".join(lines)


def _bullet_list(lines: list[str], items: list[str]) -> None:
    for item in items:
        lines.append(f"- {item}")
    lines.append("")


def _why_it_works(result: AnalysisResult) -> list[str]:
    """Synthesize a short 'why it works' list from available signals."""
    reasons: list[str] = []
    if result.hook:
        reasons.append(f"Strong hook: \"{result.hook[:80]}\"")
    if result.content_style:
        reasons.append(f"Uses a proven format: {result.content_style}")
    if result.engagement_hooks:
        reasons.append(f"Engagement techniques: {', '.join(result.engagement_hooks)}")
    if result.audience_intent:
        reasons.append(f"Clear audience intent: {result.audience_intent}")
    if result.cta_signals:
        reasons.append(f"Explicit CTAs: {', '.join(result.cta_signals)}")
    if result.keywords and len(result.keywords) >= 3:
        reasons.append(f"Keyword-rich ({', '.join(result.keywords[:5])})")
    if not reasons:
        reasons.append("Insufficient data to determine success factors")
    return reasons
