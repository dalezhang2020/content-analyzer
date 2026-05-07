"""YouTube comments fetching (requires API key)."""
from __future__ import annotations
from content_analyzer.config import Settings
from content_analyzer.models import Comment


def fetch_comments(video_id: str, max_results: int = 20) -> list[Comment] | None:
    settings = Settings.load()
    if not settings.youtube_api_key:
        return None
    try:
        from googleapiclient.discovery import build

        yt = build("youtube", "v3", developerKey=settings.youtube_api_key)
        resp = (
            yt.commentThreads()
            .list(part="snippet", videoId=video_id, maxResults=max_results, order="relevance")
            .execute()
        )
        results: list[Comment] = []
        for item in resp.get("items", []):
            snip = item["snippet"]["topLevelComment"]["snippet"]
            results.append(
                Comment(
                    author=snip.get("authorDisplayName"),
                    text=snip["textOriginal"],
                    likes=snip.get("likeCount", 0),
                )
            )
        return results
    except Exception:
        return None
