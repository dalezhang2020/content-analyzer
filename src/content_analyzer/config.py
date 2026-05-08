"""Minimal config loading."""
from __future__ import annotations
import os
from pydantic import BaseModel


class Settings(BaseModel):
    youtube_api_key: str | None = None
    openai_api_key: str | None = None
    openai_model: str = "gpt-5.4-mini"

    @classmethod
    def load(cls) -> "Settings":
        return cls(
            youtube_api_key=os.environ.get("YOUTUBE_API_KEY"),
            openai_api_key=os.environ.get("OPENAI_API_KEY"),
            openai_model=os.environ.get("OPENAI_MODEL", "gpt-5.4-mini"),
        )


settings = Settings.load()
