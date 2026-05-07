"""Core schema for analyzer output."""
from __future__ import annotations
from typing import Optional
from pydantic import BaseModel
from pydantic import Field


class Metadata(BaseModel):
    video_id: str
    title: Optional[str] = None
    channel: Optional[str] = None
    publish_date: Optional[str] = None
    duration_seconds: Optional[int] = None
    view_count: Optional[int] = None


class TranscriptSegment(BaseModel):
    start: float
    duration: float
    text: str


class Comment(BaseModel):
    author: Optional[str] = None
    text: str
    likes: int = 0


class AnalysisResult(BaseModel):
    metadata: Metadata
    transcript: Optional[list[TranscriptSegment]] = None
    comments: Optional[list[Comment]] = None
    # Parsed image analysis (structured fields from gpt4o vision)
    image_analysis: Optional[dict] = None
    # Analysis fields
    hook: Optional[str] = None
    structure: Optional[list[str]] = None
    takeaways: Optional[list[str]] = None
    reusable_angles: Optional[list[str]] = None
    # Creator teardown fields
    keywords: Optional[list[str]] = None
    content_style: Optional[str] = None
    audience_intent: Optional[str] = None
    engagement_hooks: Optional[list[str]] = None
    cta_signals: Optional[list[str]] = None
    adaptation_ideas: Optional[list[str]] = None
    warnings: list[str] = Field(default_factory=list)
