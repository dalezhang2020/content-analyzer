"""Staged pipeline wrapper that emits machine-readable stage events to stderr."""
from __future__ import annotations

import json
import sys

STAGES = ["input", "fetch", "extract", "analyze", "report", "done"]


def _emit(stage: str) -> None:
    """Write a structured stage marker to stderr."""
    sys.stderr.write(json.dumps({"__stage__": stage}) + "\n")
    sys.stderr.flush()


def run(url: str) -> None:
    """Run the analysis pipeline with explicit stage emissions."""
    from content_analyzer.adapters.xiaohongshu import is_xiaohongshu_url

    _emit("input")

    if is_xiaohongshu_url(url):
        _run_xiaohongshu(url)
    else:
        _run_youtube(url)


def _run_youtube(url: str) -> None:
    from content_analyzer.adapters.youtube import fetch_metadata, fetch_transcript, fetch_comments
    from content_analyzer.adapters.youtube.metadata import extract_video_id
    from content_analyzer.analysis import get_analyzer
    from content_analyzer.models import AnalysisResult

    _emit("fetch")
    metadata = fetch_metadata(url)
    video_id = extract_video_id(url)

    _emit("extract")
    transcript = fetch_transcript(video_id)
    comments = fetch_comments(video_id)

    warnings: list[str] = []
    if metadata.title is None:
        warnings.append(
            "Metadata is incomplete. Install the optional 'full' dependencies to enable yt-dlp metadata fallback."
        )
    if transcript is None:
        warnings.append(
            "Transcript is unavailable. youtube-transcript-api failed and yt-dlp fallback is not active or could not fetch subtitles."
        )
    if comments is None:
        warnings.append(
            "Comments are unavailable. Set YOUTUBE_API_KEY and install google-api-python-client to enable comment analysis."
        )

    result = AnalysisResult(
        metadata=metadata,
        transcript=transcript,
        comments=comments,
        warnings=warnings,
    )

    _emit("analyze")
    analyzer = get_analyzer()
    result = analyzer.analyze(result)

    _emit("report")
    output = result.model_dump_json(indent=2)

    _emit("done")
    sys.stdout.write(output)


def _run_xiaohongshu(url: str) -> None:
    from content_analyzer.adapters.xiaohongshu import fetch_note

    _emit("fetch")
    metadata, text_content, warnings, vision_prompt_tokens, vision_completion_tokens = fetch_note(url)

    _emit("extract")
    # Shared processing logic (image block parsing, transcript mapping)
    # We call _process_xiaohongshu_content but need to split analyze step for stage emission.
    # So we inline the pre-analysis part and call analyzer manually.
    if text_content is None and metadata.title is None:
        warnings.append("No text content could be extracted. Analysis will be minimal.")

    image_analysis_dict = None
    clean_text = text_content
    if text_content:
        from content_analyzer.image_analysis import split_image_block, parse_multi_image_block
        body, img_block = split_image_block(text_content)
        if img_block:
            parsed = parse_multi_image_block(img_block)
            if parsed:
                image_analysis_dict = parsed.model_dump()
                clean_parts = [body] if body else []
                if parsed.title:
                    clean_parts.append(parsed.title)
                clean_parts.extend(parsed.headings)
                clean_parts.extend(parsed.key_claims)
                clean_parts.extend(parsed.stats)
                if parsed.raw_text:
                    clean_parts.append(parsed.raw_text)
                clean_text = "\n".join(clean_parts)

    transcript = None
    if clean_text:
        from content_analyzer.models import TranscriptSegment
        transcript = [TranscriptSegment(start=0, duration=0, text=clean_text)]

    from content_analyzer.models import AnalysisResult
    result = AnalysisResult(
        metadata=metadata,
        transcript=transcript,
        comments=None,
        image_analysis=image_analysis_dict,
        warnings=warnings,
    )
    result.token_usage.vision_prompt_tokens = vision_prompt_tokens
    result.token_usage.vision_completion_tokens = vision_completion_tokens

    _emit("analyze")
    from content_analyzer.analysis import get_analyzer
    analyzer = get_analyzer()
    result = analyzer.analyze(result)

    _emit("report")
    output = result.model_dump_json(indent=2)

    _emit("done")
    sys.stdout.write(output)
