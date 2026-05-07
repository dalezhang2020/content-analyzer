"""Deterministic heuristic analyzer – no external API needed."""
from __future__ import annotations
import re
from collections import Counter
from content_analyzer.analysis.base import Analyzer
from content_analyzer.models import AnalysisResult

# Common stop words to filter from keyword extraction
_STOP_WORDS = frozenset(
    "i me my we our you your he she it they them this that these those "
    "a an the is am are was were be been being have has had do does did "
    "will would shall should can could may might must need dare "
    "and but or nor not so yet for if then else when while as at by from "
    "in into on onto to of with about between through during before after "
    "above below up down out off over under again further once here there "
    "where how what which who whom why all each every both few more most "
    "other some such no any many much too very just also still already "
    "even now than only really quite well back also got get like know "
    "think make go see come take want look give use find tell ask work "
    "seem feel try leave call good new first last long great little own "
    "old right big high different small large next early young important "
    "的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 "
    "自己 这 他 她 它 们 那 里 后 时 大 来 让 对 把 个 中 没 因为 所以 但是 如果".split()
)

# Patterns that signal a CTA
_CTA_PATTERNS = [
    r"subscribe",
    r"follow",
    r"like",
    r"comment below",
    r"share",
    r"click",
    r"link in",
    r"check out",
    r"sign up",
    r"join",
    r"download",
    r"关注",
    r"点赞",
    r"收藏",
    r"转发",
    r"评论",
    r"私信",
    r"链接",
]

# Words from image-analysis section labels to exclude from keywords
_IMAGE_SECTION_LABELS = frozenset(
    "title headings heading key claims stats cta visual framing raw text "
    "image analysis".split()
)

# Placeholder CTA values to filter out (from image-analysis outputs)
_CTA_PLACEHOLDERS = re.compile(
    r"^(n/?a|none\s*(visible|found|detected|obvious)?|no\s*(obvious\s*)?cta|"
    r"not\s*(visible|found|applicable)|无|没有|暂无|\(none\s*(visible)?\)|—|-|–)$",
    re.IGNORECASE,
)


def _clean_cta_list(items: list[str]) -> list[str]:
    """Remove placeholder/no-op CTA entries."""
    return [s for s in items if s.strip() and not _CTA_PLACEHOLDERS.match(s.strip())]


# Engagement hook indicators
_HOOK_PATTERNS = [
    (r"\?", "question"),
    (r"^(did you know|you won't believe|here's why|the secret|stop)", "curiosity opener"),
    (r"(mistake|wrong|never|avoid|don't)", "negative framing"),
    (r"(top \d|#\d|\d+ (ways|tips|things|reasons|steps))", "listicle/number"),
    (r"(story|happened|experience|journey)", "storytelling"),
    (r"(free|bonus|exclusive|limited)", "scarcity/value"),
]


class HeuristicAnalyzer(Analyzer):
    """Lightweight analysis using title, transcript, and comments."""

    def analyze(self, result: AnalysisResult) -> AnalysisResult:
        result.hook = self._extract_hook(result)
        result.structure = self._extract_structure(result)
        result.takeaways = self._extract_takeaways(result)
        result.reusable_angles = self._extract_angles(result)
        result.keywords = self._extract_keywords(result)
        result.content_style = self._detect_content_style(result)
        result.audience_intent = self._detect_audience_intent(result)
        result.engagement_hooks = self._detect_engagement_hooks(result)
        result.cta_signals = self._detect_cta_signals(result)
        result.adaptation_ideas = self._generate_adaptation_ideas(result)
        return result

    # --- helpers for image_analysis fields ---

    def _get_image_fields(self, r: AnalysisResult) -> dict | None:
        """Return parsed image_analysis dict or None."""
        return r.image_analysis if r.image_analysis else None

    # --- existing methods ---

    def _extract_hook(self, r: AnalysisResult) -> str | None:
        # Prefer image-derived title as hook for image-based notes
        img = self._get_image_fields(r)
        if img and img.get("title"):
            return img["title"]
        if r.transcript:
            hook_text = " ".join(seg.text for seg in r.transcript[:3]).strip()
            if hook_text:
                return hook_text
        if r.metadata.title:
            return r.metadata.title
        return None

    def _extract_structure(self, r: AnalysisResult) -> list[str] | None:
        # Use image headings if available
        img = self._get_image_fields(r)
        if img and img.get("headings"):
            return img["headings"]
        if not r.transcript:
            if r.metadata.title:
                return [r.metadata.title]
            return None
        segs = r.transcript
        n = len(segs)
        if n < 4:
            return [seg.text for seg in segs]
        quarter = n // 4
        sections = []
        for i in range(4):
            start = i * quarter
            end = start + quarter if i < 3 else n
            chunk = " ".join(seg.text for seg in segs[start:end])
            sections.append(chunk[:120].strip())
        return sections

    def _extract_takeaways(self, r: AnalysisResult) -> list[str] | None:
        # Prefer image-derived key claims
        img = self._get_image_fields(r)
        if img and img.get("key_claims"):
            return img["key_claims"]
        if r.comments:
            top = sorted(r.comments, key=lambda c: c.likes, reverse=True)[:3]
            takeaways = [c.text for c in top if c.text.strip()]
            if takeaways:
                return takeaways
        if r.transcript and len(r.transcript) >= 2:
            return [" ".join(seg.text for seg in r.transcript[-2:])]
        return None

    def _extract_angles(self, r: AnalysisResult) -> list[str] | None:
        angles: list[str] = []
        # Include visual framing from image analysis
        img = self._get_image_fields(r)
        if img and img.get("visual_framing"):
            for vf in img["visual_framing"]:
                angles.append(f"Visual: {vf}")
        if r.metadata.title:
            angles.append(f"Title framing: {r.metadata.title}")
        if r.metadata.view_count and r.metadata.view_count > 100_000:
            angles.append("High-view-count format worth replicating")
        if r.comments:
            questions = [c.text for c in r.comments if "?" in c.text][:2]
            for q in questions:
                angles.append(f"Audience question: {q}")
        return angles if angles else None

    # --- new creator teardown methods ---

    def _get_full_text(self, r: AnalysisResult) -> str:
        """Combine title + transcript text for analysis."""
        parts: list[str] = []
        if r.metadata.title:
            parts.append(r.metadata.title)
        if r.transcript:
            parts.append(" ".join(seg.text for seg in r.transcript))
        return " ".join(parts)

    def _extract_keywords(self, r: AnalysisResult) -> list[str] | None:
        text = self._get_full_text(r)
        if not text:
            return None
        # Tokenize: split on non-alphanumeric (keeps CJK chars as individual tokens via findall)
        tokens = re.findall(r"[\w\u4e00-\u9fff\u3400-\u4dbf]+", text.lower())
        filtered = [t for t in tokens if t not in _STOP_WORDS and t not in _IMAGE_SECTION_LABELS and len(t) > 1]
        if not filtered:
            return None
        counts = Counter(filtered)
        top = [word for word, _ in counts.most_common(10)]
        return top if top else None

    def _detect_content_style(self, r: AnalysisResult) -> str | None:
        text = self._get_full_text(r)
        if not text:
            return None
        lower = text.lower()
        # Platform-aware: XHS creator posts often use industry/explainer framing
        # Check more specific patterns first, then fall back to generic ones
        if re.search(r"(拆解|深度分析|行业|赛道|商业模式|底层逻辑|背后)", lower):
            return "industry teardown"
        if re.search(r"(合集|盘点|汇总|整理|大全|清单)", lower):
            return "roundup"
        if re.search(r"(教程|手把手|保姆级|零基础|实操)", lower):
            return "tutorial"
        if re.search(r"(测评|评测|开箱|体验|使用感受)", lower):
            return "review"
        if re.search(r"(科普|解释|是什么|为什么|原理|一文看懂|一篇讲清)", lower):
            return "explainer"
        if re.search(r"(观点|看法|我认为|吐槽|辣评|争议|热议)", lower):
            return "commentary"
        # English patterns
        if re.search(r"\d+\s*(ways|tips|things|steps|reasons|mistakes)", lower):
            return "listicle"
        if re.search(r"(story|journey|happened|experience|when i)", lower):
            return "narrative/storytelling"
        if re.search(r"(tutorial|how to|step by step|guide)", lower):
            return "tutorial/how-to"
        if re.search(r"(review|compared|vs|versus|pros and cons)", lower):
            return "review/comparison"
        if re.search(r"(vlog|day in|morning routine|daily)", lower):
            return "vlog/lifestyle"
        if re.search(r"(opinion|think|believe|rant|hot take)", lower):
            return "opinion/commentary"
        # XHS-style listicle/roundup with Chinese number patterns
        if re.search(r"(\d+个|\d+款|\d+种|\d+条)", lower):
            return "roundup"
        return "informational"

    def _detect_audience_intent(self, r: AnalysisResult) -> str | None:
        text = self._get_full_text(r)
        if not text:
            return None
        lower = text.lower()
        if re.search(r"(how to|tutorial|learn|beginner|guide|step)", lower):
            return "learn a skill or solve a problem"
        if re.search(r"(review|worth|should i|recommend|best)", lower):
            return "evaluate before a decision"
        if re.search(r"(inspiration|idea|creative|motivation)", lower):
            return "get inspired or find ideas"
        if re.search(r"(funny|laugh|meme|comedy|prank)", lower):
            return "entertainment"
        if re.search(r"(news|update|announce|breaking|latest)", lower):
            return "stay informed"
        # Check comments for intent signals
        if r.comments:
            q_count = sum(1 for c in r.comments if "?" in c.text)
            if q_count > len(r.comments) * 0.3:
                return "learn a skill or solve a problem"
        return "general interest/entertainment"

    def _detect_engagement_hooks(self, r: AnalysisResult) -> list[str] | None:
        text = self._get_full_text(r)
        if not text:
            return None
        hooks: list[str] = []
        lower = text.lower()
        for pattern, label in _HOOK_PATTERNS:
            if re.search(pattern, lower, re.IGNORECASE):
                hooks.append(label)
        # Deduplicate while preserving order
        seen: set[str] = set()
        unique: list[str] = []
        for h in hooks:
            if h not in seen:
                seen.add(h)
                unique.append(h)
        return unique if unique else None

    def _detect_cta_signals(self, r: AnalysisResult) -> list[str] | None:
        # Prefer structured image-derived CTAs (with cleanup)
        img = self._get_image_fields(r)
        if img and img.get("cta"):
            cleaned = _clean_cta_list(img["cta"])
            if cleaned:
                return cleaned
        text = self._get_full_text(r)
        if not text:
            return None
        lower = text.lower()
        found: list[str] = []
        for pattern in _CTA_PATTERNS:
            if re.search(pattern, lower):
                found.append(pattern.replace(r"\b", ""))
        return found if found else None

    def _generate_adaptation_ideas(self, r: AnalysisResult) -> list[str] | None:
        """Suggest how the user could imitate this content pattern."""
        ideas: list[str] = []
        style = r.content_style

        # Style-based suggestions
        style_templates = {
            "industry teardown": "Pick a trending brand/product in your niche and break down why it works (revenue model, audience hook, growth lever)",
            "explainer": "Take a confusing concept your audience asks about and explain it with a clear analogy or visual metaphor",
            "roundup": "Curate 5-10 items (tools, accounts, resources) your audience needs and add a one-line verdict for each",
            "tutorial": "Film/write a step-by-step walkthrough of one specific workflow your audience struggles with",
            "tutorial/how-to": "Film/write a step-by-step walkthrough of one specific workflow your audience struggles with",
            "review": "Test a product your audience is considering and give an honest verdict with specific use-case recommendations",
            "review/comparison": "Compare 2-3 options your audience is deciding between, with a clear winner for each use case",
            "commentary": "React to a trending topic or controversial take in your niche with a specific, contrarian angle",
            "opinion/commentary": "React to a trending topic or controversial take in your niche with a specific, contrarian angle",
            "listicle": "List N actionable tips/mistakes/lessons from your own experience, with one concrete example each",
            "narrative/storytelling": "Share a personal before/after story with a specific turning point and lesson",
            "vlog/lifestyle": "Document a specific day/routine that showcases your unique process or environment",
        }
        if style and style in style_templates:
            ideas.append(style_templates[style])

        # Structure-based suggestion
        if r.structure and len(r.structure) >= 3:
            ideas.append(f"Mirror the structure: {' → '.join(s[:30] for s in r.structure[:4])}")

        # Hook-based suggestion
        if r.hook:
            hook_short = r.hook[:60]
            ideas.append(f"Open with a similar hook pattern: \"{hook_short}...\" adapted to your topic")

        # Engagement technique suggestion
        if r.engagement_hooks:
            techniques = ", ".join(r.engagement_hooks[:3])
            ideas.append(f"Use these engagement techniques: {techniques}")

        # Visual framing suggestion from image analysis
        img = self._get_image_fields(r)
        if img and img.get("visual_framing"):
            vf = img["visual_framing"][0]
            ideas.append(f"Replicate the visual style: {vf}")

        return ideas if ideas else None
