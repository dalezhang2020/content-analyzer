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


class TokenUsage(BaseModel):
    """Track token consumption across API calls."""
    vision_prompt_tokens: int = 0
    vision_completion_tokens: int = 0
    analysis_prompt_tokens: int = 0
    analysis_completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return (
            self.vision_prompt_tokens
            + self.vision_completion_tokens
            + self.analysis_prompt_tokens
            + self.analysis_completion_tokens
        )

    @property
    def total_prompt_tokens(self) -> int:
        return self.vision_prompt_tokens + self.analysis_prompt_tokens

    @property
    def total_completion_tokens(self) -> int:
        return self.vision_completion_tokens + self.analysis_completion_tokens


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
    # Deep content extraction (LLM-enhanced)
    summary: Optional[str] = None  # 2-3 sentence content summary
    key_points: Optional[list[str]] = None  # Core arguments/claims (5-8 items)
    data_points: Optional[list[str]] = None  # Specific numbers, stats, facts
    content_breakdown: Optional[list[dict]] = None  # [{section, points}] structured breakdown
    target_audience: Optional[str] = None  # Specific audience description
    unique_angle: Optional[str] = None  # What makes this content different
    warnings: list[str] = Field(default_factory=list)
    # Token usage tracking
    token_usage: TokenUsage = Field(default_factory=TokenUsage)
