"""Xiaohongshu platform adapter — unified interface with xhs-cli integration.

Fetch strategy (in order):
1. xhs-cli (if installed) — handles auth/tokens automatically via browser cookies
2. Built-in fetcher (fallback) — requires full URL with xsec_token

Search:
- Only available via xhs-cli
"""
from __future__ import annotations

import json
import shutil
import subprocess
from typing import Optional

from content_analyzer.adapters.base import PlatformAdapter, SearchResult, SearchResponse
from content_analyzer.adapters.xiaohongshu.url import is_xiaohongshu_url, extract_note_id
from content_analyzer.adapters.xiaohongshu.fetcher import fetch_note
from content_analyzer.analysis import get_analyzer
from content_analyzer.image_analysis import split_image_block, parse_multi_image_block
from content_analyzer.models import AnalysisResult, Metadata, TranscriptSegment


def _xhs_cli_available() -> bool:
    """Check if xhs-cli is installed and accessible."""
    return shutil.which("xhs") is not None


def _run_xhs_cli(args: list[str], timeout: int = 30) -> tuple[Optional[dict], Optional[str]]:
    """Run xhs-cli command and return parsed JSON or error."""
    cmd = ["xhs"] + args + ["--json"]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return json.loads(proc.stdout), None
        err = proc.stderr.strip() or f"xhs-cli exited with code {proc.returncode}"
        return None, err
    except subprocess.TimeoutExpired:
        return None, "xhs-cli timed out"
    except FileNotFoundError:
        return None, "xhs-cli not found"
    except json.JSONDecodeError:
        return None, "xhs-cli returned invalid JSON"


class XiaohongshuAdapter(PlatformAdapter):
    @property
    def platform_name(self) -> str:
        return "xiaohongshu"

    def detect(self, url: str) -> bool:
        return is_xiaohongshu_url(url)

    def fetch(self, url: str) -> AnalysisResult:
        """Fetch a note. Tries xhs-cli first, falls back to built-in fetcher."""
        # Strategy 1: xhs-cli
        if _xhs_cli_available():
            result = self._fetch_via_cli(url)
            if result is not None:
                return result

        # Strategy 2: built-in fetcher (needs xsec_token in URL)
        return self._fetch_builtin(url)

    def search(self, keyword: str, page: int = 1, sort: str = "general") -> SearchResponse:
        """Search Xiaohongshu notes by keyword via xhs-cli."""
        if not _xhs_cli_available():
            return SearchResponse(
                keyword=keyword,
                platform=self.platform_name,
                warnings=["xhs-cli not installed. Install with: pip install xiaohongshu-cli"],
            )

        args = ["search", keyword, "--sort", sort, "--page", str(page)]
        data, err = _run_xhs_cli(args, timeout=30)

        if err:
            return SearchResponse(
                keyword=keyword,
                platform=self.platform_name,
                warnings=[f"Search failed: {err}"],
            )

        items: list[SearchResult] = []
        raw_items = data.get("items", []) if data else []

        for item in raw_items:
            note_card = item.get("note_card", {})
            interact = note_card.get("interact_info", {})
            user = note_card.get("user", {})

            # Parse Chinese number format (e.g. "1.5万" = 15000)
            likes = self._parse_count(interact.get("liked_count", 0))

            note_id = item.get("id", "")
            xsec_token = item.get("xsec_token", "")
            note_url = f"https://www.xiaohongshu.com/explore/{note_id}"
            if xsec_token:
                note_url += f"?xsec_token={xsec_token}"

            items.append(SearchResult(
                note_id=note_id,
                title=note_card.get("display_title", ""),
                url=note_url,
                author=user.get("nickname"),
                likes=likes,
                content_type=note_card.get("type", "normal"),
                snippet=note_card.get("desc", "")[:100] if note_card.get("desc") else None,
            ))

        return SearchResponse(
            items=items,
            keyword=keyword,
            platform=self.platform_name,
            total=len(items),
        )

    def check(self) -> tuple[bool, str]:
        if _xhs_cli_available():
            return True, "xhs-cli available (full capabilities)"
        # Built-in fetcher is always available but limited
        return True, "Built-in fetcher only (limited: needs xsec_token in URL). Install xhs-cli for full capabilities."

    # --- Private methods ---

    def _fetch_via_cli(self, url: str) -> Optional[AnalysisResult]:
        """Try fetching via xhs-cli."""
        data, err = _run_xhs_cli(["read", url], timeout=30)
        if err or not data:
            return None

        # Parse xhs-cli JSON output
        title = data.get("title")
        desc = data.get("desc", "")
        author = data.get("user", {}).get("nickname") if isinstance(data.get("user"), dict) else None
        likes = self._parse_count(data.get("interact_info", {}).get("liked_count", 0)) if isinstance(data.get("interact_info"), dict) else None

        note_id = extract_note_id(url) or url

        metadata = Metadata(
            video_id=note_id,
            title=title,
            channel=author,
            view_count=likes,
        )

        text_content = desc
        warnings: list[str] = []

        # Build result and run analysis
        return self._build_result(metadata, text_content, warnings)

    def _fetch_builtin(self, url: str) -> AnalysisResult:
        """Fetch using the built-in fetcher (original implementation)."""
        metadata, text_content, warnings, vision_prompt, vision_completion = fetch_note(url)
        result = self._process_content(metadata, text_content, warnings)
        result.token_usage.vision_prompt_tokens = vision_prompt
        result.token_usage.vision_completion_tokens = vision_completion
        return result

    def _process_content(
        self, metadata: Metadata, text_content: Optional[str], warnings: list[str]
    ) -> AnalysisResult:
        """Shared logic: parse image blocks, build AnalysisResult, run analyzer."""
        if text_content is None and metadata.title is None:
            warnings.append("No text content could be extracted. Analysis will be minimal.")

        image_analysis_dict = None
        clean_text = text_content
        if text_content:
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
            transcript = [TranscriptSegment(start=0, duration=0, text=clean_text)]

        result = AnalysisResult(
            metadata=metadata,
            transcript=transcript,
            comments=None,
            image_analysis=image_analysis_dict,
            warnings=warnings,
        )

        analyzer = get_analyzer()
        return analyzer.analyze(result)

    def _build_result(
        self, metadata: Metadata, text_content: Optional[str], warnings: list[str]
    ) -> AnalysisResult:
        """Build result from xhs-cli data (no image analysis block expected)."""
        transcript = None
        if text_content:
            transcript = [TranscriptSegment(start=0, duration=0, text=text_content)]

        result = AnalysisResult(
            metadata=metadata,
            transcript=transcript,
            comments=None,
            warnings=warnings,
        )

        analyzer = get_analyzer()
        return analyzer.analyze(result)

    @staticmethod
    def _parse_count(value) -> int:
        """Parse Chinese number format: '1.5万' → 15000, '2.3亿' → 230000000."""
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            value = value.strip()
            if value.endswith("万"):
                try:
                    return int(float(value[:-1]) * 10000)
                except ValueError:
                    return 0
            if value.endswith("亿"):
                try:
                    return int(float(value[:-1]) * 100000000)
                except ValueError:
                    return 0
            try:
                return int(value)
            except ValueError:
                return 0
        return 0
