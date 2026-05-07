"""Parse structured GPT-4o image-analysis output into typed fields."""
from __future__ import annotations

import re
from typing import Optional

from pydantic import BaseModel, Field


class ImageAnalysisFields(BaseModel):
    """Structured fields extracted from GPT-4o image analysis output."""

    title: Optional[str] = None
    headings: list[str] = Field(default_factory=list)
    key_claims: list[str] = Field(default_factory=list)
    stats: list[str] = Field(default_factory=list)
    cta: list[str] = Field(default_factory=list)
    visual_framing: list[str] = Field(default_factory=list)
    raw_text: Optional[str] = None


_SECTION_RE = re.compile(r"^##\s+(.+)$", re.MULTILINE)


def parse_image_analysis(text: str) -> Optional[ImageAnalysisFields]:
    """Parse a structured markdown block (## Title, ## Headings, etc.) into fields.

    Returns None if the text does not contain the expected structured format.
    """
    if not text or "## " not in text:
        return None

    sections: dict[str, str] = {}
    positions = [(m.start(), m.group(1).strip().lower()) for m in _SECTION_RE.finditer(text)]
    if not positions:
        return None

    for i, (pos, name) in enumerate(positions):
        # Content starts after the heading line
        line_end = text.index("\n", pos) if "\n" in text[pos:] else len(text)
        start = line_end + 1
        end = positions[i + 1][0] if i + 1 < len(positions) else len(text)
        sections[name] = text[start:end].strip()

    def _lines(key: str) -> list[str]:
        raw = sections.get(key, "")
        return [ln.lstrip("- •").strip() for ln in raw.splitlines() if ln.strip() and not ln.strip().startswith("##")]

    return ImageAnalysisFields(
        title=sections.get("title", "").strip() or None,
        headings=_lines("headings"),
        key_claims=_lines("key claims"),
        stats=_lines("stats"),
        cta=_lines("cta"),
        visual_framing=_lines("visual framing"),
        raw_text=sections.get("raw text", "").strip() or None,
    )


def _dedup_ordered(items: list[str]) -> list[str]:
    """Remove duplicates while preserving order."""
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        normalized = item.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def aggregate_image_analyses(per_image: list[ImageAnalysisFields]) -> ImageAnalysisFields:
    """Merge multiple per-image analyses into a single note-level result.

    Strategy:
    - title: first non-None title encountered (cover image is typically first)
    - headings: ordered union across all images (preserves narrative order)
    - key_claims, stats, cta, visual_framing: deduplicated union
    - raw_text: concatenated with separator
    """
    if not per_image:
        return ImageAnalysisFields()
    if len(per_image) == 1:
        return per_image[0]

    title: Optional[str] = None
    headings: list[str] = []
    key_claims: list[str] = []
    stats: list[str] = []
    cta: list[str] = []
    visual_framing: list[str] = []
    raw_parts: list[str] = []

    for fields in per_image:
        if title is None and fields.title:
            title = fields.title
        headings.extend(fields.headings)
        key_claims.extend(fields.key_claims)
        stats.extend(fields.stats)
        cta.extend(fields.cta)
        visual_framing.extend(fields.visual_framing)
        if fields.raw_text:
            raw_parts.append(fields.raw_text)

    return ImageAnalysisFields(
        title=title,
        headings=_dedup_ordered(headings),
        key_claims=_dedup_ordered(key_claims),
        stats=_dedup_ordered(stats),
        cta=_dedup_ordered(cta),
        visual_framing=_dedup_ordered(visual_framing),
        raw_text="\n---\n".join(raw_parts) if raw_parts else None,
    )


def parse_multi_image_block(text: str) -> Optional[ImageAnalysisFields]:
    """Parse a combined multi-image analysis block.

    Splits on repeated ## Title boundaries (each image starts a new ## Title)
    and aggregates per-image results into a single note-level analysis.
    """
    if not text or "## " not in text:
        return None

    # Split into per-image chunks: each chunk starts at a ## Title heading
    # (except possibly the first chunk which may not start with ## Title)
    title_starts = [m.start() for m in re.finditer(r"^## Title\b", text, re.MULTILINE | re.IGNORECASE)]

    if len(title_starts) <= 1:
        # Single image or no ## Title boundaries: parse as one block
        return parse_image_analysis(text)

    # Multiple ## Title occurrences: split into per-image chunks
    chunks: list[str] = []
    for i, start in enumerate(title_starts):
        end = title_starts[i + 1] if i + 1 < len(title_starts) else len(text)
        chunks.append(text[start:end].strip())

    per_image: list[ImageAnalysisFields] = []
    for chunk in chunks:
        parsed = parse_image_analysis(chunk)
        if parsed:
            per_image.append(parsed)

    if not per_image:
        return None

    return aggregate_image_analyses(per_image)


def split_image_block(text_content: str) -> tuple[str, Optional[str]]:
    """Split text_content into (body, image_analysis_block).

    The image_analysis_block is the text after the [Image Analysis] marker.
    Returns (full_text, None) if no marker is present.
    """
    marker = "[Image Analysis]"
    idx = text_content.find(marker)
    if idx == -1:
        return text_content, None
    body = text_content[:idx].strip()
    block = text_content[idx + len(marker):].strip()
    return body, block
