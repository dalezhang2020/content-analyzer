"""Tests for image analysis parsing, merge behavior, keyword cleanup, CTA accuracy, and report output."""
from content_analyzer.image_analysis import (
    parse_image_analysis, split_image_block, ImageAnalysisFields,
    aggregate_image_analyses, parse_multi_image_block, _dedup_ordered,
)
from content_analyzer.analysis.heuristic import HeuristicAnalyzer
from content_analyzer.models import AnalysisResult, Metadata, TranscriptSegment
from content_analyzer.report import render_markdown


# --- Sample structured GPT-4o output ---
SAMPLE_IMAGE_BLOCK = """\
## Title
5个让你效率翻倍的工作习惯

## Headings
- 习惯一：早起规划
- 习惯二：番茄工作法
- 习惯三：减少会议

## Key Claims
- 早起30分钟可以提升全天效率
- 番茄工作法减少分心次数50%
- 每周减少3个会议节省6小时

## Stats
- 效率提升200%
- 30分钟早起
- 50%减少分心

## CTA
- 点赞收藏这篇笔记
- 关注我获取更多效率技巧

## Visual Framing
- 数字列表格式，每个习惯配图标
- 渐变色背景突出重点数据

## Raw Text
@效率达人小王 | 职场效率分享
"""


class TestParseImageAnalysis:
    def test_parses_all_sections(self):
        result = parse_image_analysis(SAMPLE_IMAGE_BLOCK)
        assert result is not None
        assert result.title == "5个让你效率翻倍的工作习惯"
        assert len(result.headings) == 3
        assert "习惯一：早起规划" in result.headings
        assert len(result.key_claims) == 3
        assert "番茄工作法减少分心次数50%" in result.key_claims
        assert len(result.stats) == 3
        assert len(result.cta) == 2
        assert "关注我获取更多效率技巧" in result.cta
        assert len(result.visual_framing) == 2
        assert result.raw_text is not None
        assert "@效率达人小王" in result.raw_text

    def test_returns_none_for_unstructured_text(self):
        assert parse_image_analysis("Just some plain text without sections") is None

    def test_returns_none_for_empty(self):
        assert parse_image_analysis("") is None

    def test_partial_sections(self):
        text = "## Title\nHello World\n\n## CTA\n- Follow me\n"
        result = parse_image_analysis(text)
        assert result is not None
        assert result.title == "Hello World"
        assert result.cta == ["Follow me"]
        assert result.headings == []
        assert result.key_claims == []


class TestSplitImageBlock:
    def test_splits_correctly(self):
        text = "Some description\n\n[Image Analysis]\n## Title\nHello"
        body, block = split_image_block(text)
        assert body == "Some description"
        assert block == "## Title\nHello"

    def test_no_marker(self):
        text = "Just normal text"
        body, block = split_image_block(text)
        assert body == "Just normal text"
        assert block is None

    def test_empty_body(self):
        text = "[Image Analysis]\n## Title\nTest"
        body, block = split_image_block(text)
        assert body == ""
        assert block == "## Title\nTest"


class TestKeywordCleanup:
    def test_excludes_section_labels(self):
        """Keywords should not contain image-analysis section label words."""
        # Simulate text that would contain section labels if not cleaned
        text = "title headings key claims stats cta visual framing raw text python tutorial python basics"
        r = AnalysisResult(
            metadata=Metadata(video_id="test", title="Python Tutorial"),
            transcript=[TranscriptSegment(start=0, duration=0, text=text)],
        )
        result = HeuristicAnalyzer().analyze(r)
        assert result.keywords is not None
        assert "python" in result.keywords
        # Section labels should be filtered out
        assert "title" not in result.keywords
        assert "headings" not in result.keywords
        assert "claims" not in result.keywords
        assert "framing" not in result.keywords


class TestCtaFromImageAnalysis:
    def test_uses_image_cta_over_regex(self):
        """When image_analysis has CTA fields, those are used directly."""
        r = AnalysisResult(
            metadata=Metadata(video_id="test"),
            transcript=[TranscriptSegment(start=0, duration=0, text="some content")],
            image_analysis={
                "cta": ["点赞收藏这篇笔记", "关注我获取更多效率技巧"],
                "title": None,
                "headings": [],
                "key_claims": [],
                "stats": [],
                "visual_framing": [],
                "raw_text": None,
            },
        )
        result = HeuristicAnalyzer().analyze(r)
        assert result.cta_signals == ["点赞收藏这篇笔记", "关注我获取更多效率技巧"]

    def test_falls_back_to_regex_without_image(self):
        """Without image_analysis, regex CTA detection still works."""
        r = AnalysisResult(
            metadata=Metadata(video_id="test"),
            transcript=[TranscriptSegment(start=0, duration=0, text="subscribe and follow for more")],
        )
        result = HeuristicAnalyzer().analyze(r)
        assert result.cta_signals is not None
        assert "subscribe" in result.cta_signals


class TestImageFieldsInAnalysis:
    def test_hook_from_image_title(self):
        r = AnalysisResult(
            metadata=Metadata(video_id="test", title="Page Title"),
            transcript=[TranscriptSegment(start=0, duration=0, text="body text")],
            image_analysis={"title": "Image Title", "headings": [], "key_claims": [], "stats": [], "cta": [], "visual_framing": [], "raw_text": None},
        )
        result = HeuristicAnalyzer().analyze(r)
        assert result.hook == "Image Title"

    def test_structure_from_image_headings(self):
        r = AnalysisResult(
            metadata=Metadata(video_id="test"),
            transcript=[TranscriptSegment(start=0, duration=0, text="body")],
            image_analysis={"title": None, "headings": ["Section A", "Section B"], "key_claims": [], "stats": [], "cta": [], "visual_framing": [], "raw_text": None},
        )
        result = HeuristicAnalyzer().analyze(r)
        assert result.structure == ["Section A", "Section B"]

    def test_takeaways_from_key_claims(self):
        r = AnalysisResult(
            metadata=Metadata(video_id="test"),
            transcript=[TranscriptSegment(start=0, duration=0, text="body")],
            image_analysis={"title": None, "headings": [], "key_claims": ["Claim 1", "Claim 2"], "stats": [], "cta": [], "visual_framing": [], "raw_text": None},
        )
        result = HeuristicAnalyzer().analyze(r)
        assert result.takeaways == ["Claim 1", "Claim 2"]

    def test_angles_include_visual_framing(self):
        r = AnalysisResult(
            metadata=Metadata(video_id="test", title="Test"),
            image_analysis={"title": None, "headings": [], "key_claims": [], "stats": [], "cta": [], "visual_framing": ["Bold numbered list"], "raw_text": None},
        )
        result = HeuristicAnalyzer().analyze(r)
        assert result.reusable_angles is not None
        assert any("Visual:" in a for a in result.reusable_angles)


class TestReportWithImageAnalysis:
    def test_report_renders_image_derived_fields(self):
        """Report renders cleanly when fields come from image analysis."""
        r = AnalysisResult(
            metadata=Metadata(video_id="xhs_123", title="效率翻倍"),
            hook="5个让你效率翻倍的工作习惯",
            structure=["习惯一：早起规划", "习惯二：番茄工作法"],
            takeaways=["早起30分钟可以提升全天效率"],
            cta_signals=["点赞收藏这篇笔记", "关注我获取更多效率技巧"],
            keywords=["效率", "习惯", "工作"],
            reusable_angles=["Visual: 数字列表格式"],
            image_analysis={"title": "5个让你效率翻倍的工作习惯"},
        )
        md = render_markdown(r)
        assert "效率翻倍" in md
        assert "## CTA Signals" in md
        assert "点赞收藏这篇笔记" in md
        assert "## Keywords" in md
        assert "效率" in md

    def test_json_includes_image_analysis_field(self):
        """JSON output includes the image_analysis field."""
        import json
        r = AnalysisResult(
            metadata=Metadata(video_id="test"),
            image_analysis={"title": "Test", "cta": ["follow"]},
        )
        data = json.loads(r.model_dump_json())
        assert "image_analysis" in data
        assert data["image_analysis"]["title"] == "Test"

    def test_json_image_analysis_null_when_absent(self):
        """image_analysis is null in JSON when not set."""
        import json
        r = AnalysisResult(metadata=Metadata(video_id="test"))
        data = json.loads(r.model_dump_json())
        assert data["image_analysis"] is None


# --- Multi-image aggregation tests ---

SAMPLE_IMAGE_1 = """\
## Title
5个让你效率翻倍的工作习惯

## Headings
- 习惯一：早起规划
- 习惯二：番茄工作法

## Key Claims
- 早起30分钟可以提升全天效率
- 番茄工作法减少分心次数50%

## Stats
- 效率提升200%

## CTA
- 点赞收藏这篇笔记

## Visual Framing
- 数字列表格式，每个习惯配图标
"""

SAMPLE_IMAGE_2 = """\
## Title
工作习惯（续）

## Headings
- 习惯三：减少会议
- 习惯四：深度工作

## Key Claims
- 每周减少3个会议节省6小时
- 深度工作2小时等于普通4小时

## Stats
- 6小时节省
- 深度工作效率2x

## CTA
- 关注我获取更多效率技巧
- 点赞收藏这篇笔记

## Visual Framing
- 渐变色背景突出重点数据

## Raw Text
@效率达人小王 | 职场效率分享
"""

SAMPLE_IMAGE_3 = """\
## Title
总结页

## Headings
- 总结：5个习惯回顾

## Key Claims
- 早起30分钟可以提升全天效率

## Stats
- 效率提升200%

## CTA
- 关注我获取更多效率技巧
"""


class TestDedupOrdered:
    def test_removes_duplicates(self):
        assert _dedup_ordered(["a", "b", "a", "c"]) == ["a", "b", "c"]

    def test_preserves_order(self):
        assert _dedup_ordered(["c", "b", "a"]) == ["c", "b", "a"]

    def test_strips_whitespace(self):
        assert _dedup_ordered(["  a  ", "a", " b"]) == ["a", "b"]

    def test_empty_list(self):
        assert _dedup_ordered([]) == []

    def test_skips_empty_strings(self):
        assert _dedup_ordered(["a", "", "b", "  "]) == ["a", "b"]


class TestAggregateImageAnalyses:
    def test_single_image_passthrough(self):
        fields = parse_image_analysis(SAMPLE_IMAGE_1)
        assert fields is not None
        result = aggregate_image_analyses([fields])
        assert result.title == fields.title
        assert result.headings == fields.headings

    def test_multi_image_title_uses_first(self):
        f1 = parse_image_analysis(SAMPLE_IMAGE_1)
        f2 = parse_image_analysis(SAMPLE_IMAGE_2)
        result = aggregate_image_analyses([f1, f2])
        assert result.title == "5个让你效率翻倍的工作习惯"

    def test_multi_image_headings_ordered_union(self):
        f1 = parse_image_analysis(SAMPLE_IMAGE_1)
        f2 = parse_image_analysis(SAMPLE_IMAGE_2)
        result = aggregate_image_analyses([f1, f2])
        assert "习惯一：早起规划" in result.headings
        assert "习惯三：减少会议" in result.headings
        assert "习惯四：深度工作" in result.headings
        # Order preserved: image1 headings before image2
        idx1 = result.headings.index("习惯一：早起规划")
        idx3 = result.headings.index("习惯三：减少会议")
        assert idx1 < idx3

    def test_multi_image_deduplicates_claims(self):
        f1 = parse_image_analysis(SAMPLE_IMAGE_1)
        f3 = parse_image_analysis(SAMPLE_IMAGE_3)
        result = aggregate_image_analyses([f1, f3])
        # "早起30分钟可以提升全天效率" appears in both but should only appear once
        assert result.key_claims.count("早起30分钟可以提升全天效率") == 1

    def test_multi_image_deduplicates_stats(self):
        f1 = parse_image_analysis(SAMPLE_IMAGE_1)
        f2 = parse_image_analysis(SAMPLE_IMAGE_2)
        f3 = parse_image_analysis(SAMPLE_IMAGE_3)
        result = aggregate_image_analyses([f1, f2, f3])
        assert result.stats.count("效率提升200%") == 1

    def test_multi_image_deduplicates_cta(self):
        f1 = parse_image_analysis(SAMPLE_IMAGE_1)
        f2 = parse_image_analysis(SAMPLE_IMAGE_2)
        f3 = parse_image_analysis(SAMPLE_IMAGE_3)
        result = aggregate_image_analyses([f1, f2, f3])
        assert result.cta.count("点赞收藏这篇笔记") == 1
        assert result.cta.count("关注我获取更多效率技巧") == 1

    def test_multi_image_raw_text_concatenated(self):
        f1 = parse_image_analysis(SAMPLE_IMAGE_1)
        f2 = parse_image_analysis(SAMPLE_IMAGE_2)
        result = aggregate_image_analyses([f1, f2])
        # f1 has no raw_text, f2 does
        assert result.raw_text is not None
        assert "@效率达人小王" in result.raw_text

    def test_empty_list(self):
        result = aggregate_image_analyses([])
        assert result.title is None
        assert result.headings == []


class TestParseMultiImageBlock:
    def test_single_image_block(self):
        result = parse_multi_image_block(SAMPLE_IMAGE_1)
        assert result is not None
        assert result.title == "5个让你效率翻倍的工作习惯"

    def test_multi_image_combined_block(self):
        combined = SAMPLE_IMAGE_1 + "\n" + SAMPLE_IMAGE_2
        result = parse_multi_image_block(combined)
        assert result is not None
        assert result.title == "5个让你效率翻倍的工作习惯"
        assert len(result.headings) == 4
        assert "习惯三：减少会议" in result.headings

    def test_three_images_combined(self):
        combined = SAMPLE_IMAGE_1 + "\n" + SAMPLE_IMAGE_2 + "\n" + SAMPLE_IMAGE_3
        result = parse_multi_image_block(combined)
        assert result is not None
        # Title from first image
        assert result.title == "5个让你效率翻倍的工作习惯"
        # All unique headings
        assert "总结：5个习惯回顾" in result.headings
        # Deduplication
        assert result.key_claims.count("早起30分钟可以提升全天效率") == 1

    def test_returns_none_for_empty(self):
        assert parse_multi_image_block("") is None
        assert parse_multi_image_block("no sections here") is None


class TestMultiImageInHeuristicAnalyzer:
    def test_aggregated_fields_drive_analysis(self):
        """When image_analysis has aggregated multi-image data, all fields are used."""
        # Simulate aggregated result
        f1 = parse_image_analysis(SAMPLE_IMAGE_1)
        f2 = parse_image_analysis(SAMPLE_IMAGE_2)
        aggregated = aggregate_image_analyses([f1, f2])

        r = AnalysisResult(
            metadata=Metadata(video_id="xhs_multi"),
            transcript=[TranscriptSegment(start=0, duration=0, text="效率习惯分享")],
            image_analysis=aggregated.model_dump(),
        )
        result = HeuristicAnalyzer().analyze(r)

        # Hook from aggregated title (first image)
        assert result.hook == "5个让你效率翻倍的工作习惯"
        # Structure from all headings
        assert len(result.structure) == 4
        assert "习惯四：深度工作" in result.structure
        # Takeaways from all key claims
        assert len(result.takeaways) >= 3
        # CTA from aggregated
        assert "关注我获取更多效率技巧" in result.cta_signals

    def test_report_renders_multi_image_aggregated(self):
        """Report renders correctly with multi-image aggregated data."""
        f1 = parse_image_analysis(SAMPLE_IMAGE_1)
        f2 = parse_image_analysis(SAMPLE_IMAGE_2)
        aggregated = aggregate_image_analyses([f1, f2])

        r = AnalysisResult(
            metadata=Metadata(video_id="xhs_multi", title="效率翻倍"),
            transcript=[TranscriptSegment(start=0, duration=0, text="效率习惯")],
            image_analysis=aggregated.model_dump(),
        )
        result = HeuristicAnalyzer().analyze(r)
        md = render_markdown(result)
        assert "## Structure" in md
        assert "习惯三：减少会议" in md
        assert "## Key Takeaways" in md
