"""Pipeline orchestration."""
from __future__ import annotations
from content_analyzer.adapters.youtube import fetch_metadata, fetch_transcript, fetch_comments
from content_analyzer.adapters.youtube.metadata import extract_video_id
from content_analyzer.adapters.xiaohongshu import is_xiaohongshu_url, fetch_note
from content_analyzer.analysis import get_analyzer
from content_analyzer.models import AnalysisResult, TranscriptSegment


def _process_xiaohongshu_content(
    metadata, text_content: str | None, warnings: list[str]
) -> AnalysisResult:
    """Shared logic: parse image blocks, build AnalysisResult, run analyzer."""
    if text_content is None and metadata.title is None:
        warnings.append("No text content could be extracted. Analysis will be minimal.")

    # Parse structured image analysis block if present
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
            else:
                clean_text = text_content
        else:
            clean_text = text_content

    # Map text_content into transcript-like field for downstream analysis compatibility
    transcript = None
    if clean_text:
        transcript = [TranscriptSegment(start=0, duration=0, text=clean_text)]

    result = AnalysisResult(
        metadata=metadata,
        transcript=transcript,
        comments=None,
        image_analysis=image_analysis_dict,
        warnings=warnings,
    )

    analyzer = get_analyzer()
    result = analyzer.analyze(result)
    return result


def analyze_xiaohongshu(url: str) -> AnalysisResult:
    """Analyze a single Xiaohongshu note URL."""
    metadata, text_content, warnings = fetch_note(url)
    return _process_xiaohongshu_content(metadata, text_content, warnings)


def analyze_youtube(url: str) -> AnalysisResult:
    warnings: list[str] = []
    metadata = fetch_metadata(url)
    video_id = extract_video_id(url)
    transcript = fetch_transcript(video_id)
    comments = fetch_comments(video_id)

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

    analyzer = get_analyzer()
    result = analyzer.analyze(result)
    return result
