"""Xiaohongshu adapter – single-link note extraction."""
from content_analyzer.adapters.xiaohongshu.url import is_xiaohongshu_url, extract_note_id
from content_analyzer.adapters.xiaohongshu.fetcher import fetch_note
from content_analyzer.adapters.xiaohongshu.ocr import ocr_available
from content_analyzer.adapters.xiaohongshu.mistral_ocr import mistral_ocr_available
from content_analyzer.adapters.xiaohongshu.gpt4o_ocr import gpt4o_ocr_available

__all__ = ["is_xiaohongshu_url", "extract_note_id", "fetch_note", "ocr_available", "mistral_ocr_available", "gpt4o_ocr_available"]

