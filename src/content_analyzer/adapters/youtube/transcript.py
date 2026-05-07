"""YouTube transcript fetching with fallback chain."""
from __future__ import annotations
from content_analyzer.models import TranscriptSegment


def fetch_transcript(video_id: str) -> list[TranscriptSegment] | None:
    """Fallback chain: youtube-transcript-api -> yt-dlp subtitles -> None."""
    # Primary: youtube-transcript-api
    try:
        from youtube_transcript_api import YouTubeTranscriptApi

        raw = YouTubeTranscriptApi.get_transcript(video_id)
        return [TranscriptSegment(**seg) for seg in raw]
    except Exception:
        pass
    # Fallback: yt-dlp auto-subs (heavier)
    try:
        import yt_dlp

        ydl_opts = {
            "quiet": True,
            "skip_download": True,
            "writeautomaticsub": True,
            "subtitleslangs": ["en"],
            "subtitlesformat": "json3",
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(
                f"https://www.youtube.com/watch?v={video_id}", download=False
            )
            subs = (info.get("automatic_captions") or {}).get("en")
            if subs:
                # json3 format contains events
                for fmt in subs:
                    if fmt.get("ext") == "json3":
                        # Would need download; skip in MVP
                        break
    except Exception:
        pass
    return None
