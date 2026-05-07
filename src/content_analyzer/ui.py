"""Content Analyzer Workbench — local Streamlit UI."""
from __future__ import annotations

import streamlit as st

from content_analyzer.adapters.xiaohongshu import is_xiaohongshu_url
from content_analyzer.models import AnalysisResult
from content_analyzer.pipeline import analyze_youtube, analyze_xiaohongshu
from content_analyzer.report import render_markdown


# ---------------------------------------------------------------------------
# Page config
# ---------------------------------------------------------------------------

st.set_page_config(
    page_title="Content Analyzer Workbench",
    page_icon="🔬",
    layout="wide",
)

# ---------------------------------------------------------------------------
# Custom styling — intentional, focused tool aesthetic
# ---------------------------------------------------------------------------

st.markdown(
    """
    <style>
    /* Tighten spacing */
    .block-container { padding-top: 2rem; max-width: 960px; }
    /* Input area */
    .stTextInput > div > div > input { font-size: 1rem; }
    /* Status badges */
    .status-badge {
        display: inline-block;
        padding: 0.2em 0.6em;
        border-radius: 4px;
        font-size: 0.8rem;
        font-weight: 600;
        margin-right: 0.4em;
    }
    .badge-done { background: #d4edda; color: #155724; }
    .badge-running { background: #fff3cd; color: #856404; }
    .badge-error { background: #f8d7da; color: #721c24; }
    </style>
    """,
    unsafe_allow_html=True,
)

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

st.title("🔬 Content Analyzer Workbench")
st.caption("Analyze YouTube & Xiaohongshu content for creator insights.")

# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------

url = st.text_input(
    "Paste a URL",
    placeholder="https://www.youtube.com/watch?v=... or https://www.xiaohongshu.com/explore/...",
    label_visibility="collapsed",
)

run_btn = st.button("Analyze", type="primary", disabled=not url)

# ---------------------------------------------------------------------------
# Analysis execution with progress
# ---------------------------------------------------------------------------


def run_analysis(url: str) -> AnalysisResult:
    """Run the analysis pipeline, updating progress in the UI."""
    is_xhs = is_xiaohongshu_url(url)
    platform = "Xiaohongshu" if is_xhs else "YouTube"

    progress = st.status(f"Analyzing {platform} content…", expanded=True)

    with progress:
        st.write("⏳ Fetching content & metadata…")
        if is_xhs:
            result = analyze_xiaohongshu(url)
        else:
            result = analyze_youtube(url)
        st.write("✅ Analysis complete.")

    progress.update(label=f"✅ {platform} analysis done", state="complete")
    return result


# ---------------------------------------------------------------------------
# Rendering helpers
# ---------------------------------------------------------------------------


def render_metadata(result: AnalysisResult) -> None:
    """Render summary metadata block."""
    m = result.metadata
    cols = st.columns(4)
    with cols[0]:
        st.metric("Title", m.title or m.video_id)
    with cols[1]:
        st.metric("Channel / Author", m.channel or "—")
    with cols[2]:
        if m.view_count is not None:
            st.metric("Views", f"{m.view_count:,}")
        else:
            st.metric("Views", "—")
    with cols[3]:
        if m.duration_seconds is not None:
            mins, secs = divmod(m.duration_seconds, 60)
            st.metric("Duration", f"{mins}m {secs}s")
        else:
            st.metric("Duration", "—")


def render_teardown(result: AnalysisResult) -> None:
    """Render structured teardown fields."""
    fields = [
        ("Hook", result.hook),
        ("Content Style", result.content_style),
        ("Audience Intent", result.audience_intent),
    ]
    for label, value in fields:
        if value:
            st.markdown(f"**{label}:** {value}")

    list_fields = [
        ("Structure", result.structure),
        ("Keywords", result.keywords),
        ("Engagement Hooks", result.engagement_hooks),
        ("CTA Signals", result.cta_signals),
        ("Reusable Angles", result.reusable_angles),
        ("Adaptation Ideas", result.adaptation_ideas),
        ("Key Takeaways", result.takeaways),
    ]
    for label, items in list_fields:
        if items:
            st.markdown(f"**{label}**")
            for item in items:
                st.markdown(f"- {item}")


def render_image_analysis(image_analysis: dict | None) -> None:
    """Render image analysis fields if present."""
    if not image_analysis:
        return
    if image_analysis.get("title"):
        st.markdown(f"**Title:** {image_analysis['title']}")
    for key in ("headings", "key_claims", "stats", "cta", "visual_framing"):
        items = image_analysis.get(key)
        if items:
            st.markdown(f"**{key.replace('_', ' ').title()}**")
            for item in items:
                st.markdown(f"- {item}")
    if image_analysis.get("raw_text"):
        with st.expander("Raw OCR text"):
            st.text(image_analysis["raw_text"])


def render_warnings(warnings: list[str]) -> None:
    """Render warnings."""
    for w in warnings:
        st.warning(w, icon="⚠️")


# ---------------------------------------------------------------------------
# Main display
# ---------------------------------------------------------------------------

if run_btn and url:
    try:
        result = run_analysis(url.strip())
    except Exception as e:
        st.error(f"Analysis failed: {e}")
        st.stop()

    # Store in session for tab persistence
    st.session_state["last_result"] = result

if "last_result" in st.session_state:
    result: AnalysisResult = st.session_state["last_result"]

    # Warnings first
    if result.warnings:
        render_warnings(result.warnings)

    # Tabs for different views
    tab_teardown, tab_images, tab_report, tab_json = st.tabs(
        ["Teardown", "Image Analysis", "Markdown Report", "Raw JSON"]
    )

    with tab_teardown:
        render_metadata(result)
        st.divider()
        render_teardown(result)

    with tab_images:
        if result.image_analysis:
            render_image_analysis(result.image_analysis)
        else:
            st.info("No image analysis data for this content.")

    with tab_report:
        st.markdown(render_markdown(result))

    with tab_json:
        st.json(result.model_dump())
