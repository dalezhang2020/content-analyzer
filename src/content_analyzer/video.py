"""Generate professional HyperFrames video compositions from analysis results.

Produces information-dense, multi-scene videos with:
- Rich content breakdown (not just a few lines of text)
- Visual hierarchy (titles, subtitles, lists, data highlights)
- Tight pacing with varied scene layouts
- Professional color palette with accent highlights
"""
from __future__ import annotations

import html
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from content_analyzer.models import AnalysisResult


# --- Color palette ---
_P = {
    "bg": "#0f1117",
    "surface": "#1a1d27",
    "card": "#222633",
    "text": "#f0f1f5",
    "muted": "#8b8fa3",
    "accent1": "#6ee7b7",  # green
    "accent2": "#818cf8",  # purple
    "accent3": "#fbbf24",  # amber
    "accent4": "#f472b6",  # pink
    "border": "#2d3348",
}


def _esc(text: str) -> str:
    return html.escape(text, quote=True)


class VideoScript:
    """Build a rich multi-scene script from analysis data."""

    def __init__(self, result: AnalysisResult):
        self.r = result
        self.scenes: list[dict] = []
        self._build()

    def _build(self) -> None:
        r = self.r

        # Scene 1: Title card
        self.scenes.append({
            "type": "title",
            "title": r.metadata.title or r.hook or "Content Analysis",
            "subtitle": r.summary or f"By @{r.metadata.channel}" if r.metadata.channel else "",
            "badge": r.content_style or "analysis",
        })

        # Scene 2: Key Points (the meat)
        points = r.key_points or r.takeaways or r.structure or []
        if points:
            self.scenes.append({
                "type": "points",
                "label": "KEY INSIGHTS",
                "points": points[:6],
            })

        # Scene 3: Content Structure / Breakdown
        if r.content_breakdown and len(r.content_breakdown) >= 2:
            sections = r.content_breakdown[:4]
            self.scenes.append({
                "type": "breakdown",
                "label": "CONTENT STRUCTURE",
                "sections": sections,
            })
        elif r.structure and len(r.structure) >= 3:
            self.scenes.append({
                "type": "flow",
                "label": "STRUCTURE",
                "steps": r.structure[:6],
            })

        # Scene 4: Data & Evidence
        data_items = r.data_points or []
        if data_items:
            self.scenes.append({
                "type": "data",
                "label": "DATA & EVIDENCE",
                "items": data_items[:5],
            })

        # Scene 5: Why It Works / Unique Angle
        why_items = []
        if r.unique_angle:
            why_items.append(r.unique_angle)
        if r.engagement_hooks:
            why_items.extend(r.engagement_hooks[:3])
        if r.audience_intent:
            why_items.append(f"Audience: {r.audience_intent}")
        if why_items:
            self.scenes.append({
                "type": "points",
                "label": "WHY IT WORKS",
                "points": why_items[:5],
            })

        # Scene 6: Adaptation / Your Move
        ideas = r.adaptation_ideas or r.reusable_angles or []
        if ideas:
            self.scenes.append({
                "type": "action",
                "label": "YOUR MOVE",
                "items": ideas[:4],
            })

        # Scene 7: Keywords + CTA
        kws = r.keywords or []
        self.scenes.append({
            "type": "closing",
            "keywords": kws[:8],
            "audience": r.target_audience or "",
        })

        # Ensure at least 4 scenes
        if len(self.scenes) < 4:
            if r.takeaways:
                self.scenes.insert(-1, {
                    "type": "points",
                    "label": "TAKEAWAYS",
                    "points": r.takeaways[:5],
                })


def generate_video_composition(result: AnalysisResult, output_dir: str | Path) -> Path:
    """Generate a HyperFrames composition from an AnalysisResult."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    script = VideoScript(result)
    html_content = _render(script)

    index_path = output_dir / "index.html"
    index_path.write_text(html_content, encoding="utf-8")
    return index_path


def render_video(composition_dir: str | Path, output_path: str | Path | None = None, fps: int = 30) -> Optional[Path]:
    """Render a HyperFrames composition to MP4."""
    composition_dir = Path(composition_dir)
    if output_path is None:
        output_path = composition_dir / "output.mp4"
    else:
        output_path = Path(output_path)

    if not shutil.which("npx"):
        raise RuntimeError("npx not found. Install Node.js to use HyperFrames rendering.")

    proc = subprocess.run(
        ["npx", "hyperframes", "render", "--output", str(output_path), "--fps", str(fps)],
        cwd=str(composition_dir),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"HyperFrames render failed:\n{proc.stderr}")
    return output_path if output_path.exists() else None


# --- HTML Rendering ---

def _render(script: VideoScript) -> str:
    p = _P
    scenes = script.scenes

    # Calculate timing: 3-4s per scene
    timings: list[tuple[float, float]] = []
    t = 0.0
    for scene in scenes:
        dur = 4.0
        if scene["type"] == "title":
            dur = 3.5
        elif scene["type"] == "closing":
            dur = 3.0
        elif scene["type"] == "breakdown":
            dur = 5.0
        elif scene["type"] == "points" and len(scene.get("points", [])) > 4:
            dur = 4.5
        timings.append((t, dur))
        t += dur + 0.2

    total = timings[-1][0] + timings[-1][1]

    # Build HTML scenes
    scene_parts = []
    gsap_parts = []
    for i, (scene, (start, dur)) in enumerate(zip(scenes, timings)):
        sid = f"s{i+1}"
        h, g = _render_scene(scene, sid, start, dur, i == len(scenes) - 1)
        scene_parts.append(h)
        gsap_parts.append(g)

    scenes_html = "\n\n".join(scene_parts)
    gsap_code = "\n\n".join(gsap_parts)

    return f'''<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body>
<div id="root" data-composition-id="root" data-start="0" data-width="1920" data-height="1080">
{scenes_html}
</div>

<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ background: {p["bg"]}; overflow: hidden; }}
[data-composition-id="root"] {{
  position: relative; width: 1920px; height: 1080px;
  background: {p["bg"]}; font-family: 'Inter', sans-serif;
}}
.scene {{ position: absolute; top: 0; left: 0; width: 100%; height: 100%; }}
.sc {{ display: flex; flex-direction: column; justify-content: center; width: 100%; height: 100%; padding: 100px 140px; gap: 24px; }}
.sc-split {{ display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: start; padding: 100px 120px; width: 100%; height: 100%; }}
.label {{ font-size: 13px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: {p["accent1"]}; }}
.title {{ font-size: 56px; font-weight: 800; color: {p["text"]}; letter-spacing: -0.02em; line-height: 1.15; max-width: 1400px; }}
.subtitle {{ font-size: 22px; font-weight: 400; color: {p["muted"]}; line-height: 1.5; max-width: 1000px; }}
.badge {{ display: inline-block; background: {p["card"]}; border: 1px solid {p["border"]}; border-radius: 6px; padding: 4px 12px; font-size: 13px; color: {p["accent2"]}; font-weight: 600; }}
.pt {{ display: flex; align-items: flex-start; gap: 14px; }}
.pt-num {{ font-size: 13px; font-weight: 700; color: {p["accent2"]}; min-width: 22px; padding-top: 4px; }}
.pt-text {{ font-size: 26px; font-weight: 500; color: {p["text"]}; line-height: 1.4; }}
.pt-sm {{ font-size: 22px; }}
.section-title {{ font-size: 20px; font-weight: 700; color: {p["accent3"]}; margin-bottom: 8px; }}
.section-pts {{ font-size: 18px; color: {p["muted"]}; line-height: 1.6; }}
.data-item {{ display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: {p["card"]}; border-radius: 8px; border-left: 3px solid {p["accent3"]}; }}
.data-text {{ font-size: 22px; font-weight: 500; color: {p["text"]}; }}
.kw-grid {{ display: flex; flex-wrap: wrap; gap: 10px; }}
.kw {{ background: {p["card"]}; border: 1px solid {p["border"]}; border-radius: 6px; padding: 8px 16px; font-size: 16px; color: {p["muted"]}; }}
.action-item {{ padding: 14px 18px; background: {p["surface"]}; border-radius: 8px; border-left: 3px solid {p["accent1"]}; font-size: 20px; color: {p["text"]}; line-height: 1.4; }}
.glow {{ position: absolute; width: 500px; height: 500px; border-radius: 50%; opacity: 0.06; pointer-events: none; }}
.glow-1 {{ top: -100px; right: -100px; background: {p["accent2"]}; }}
.glow-2 {{ bottom: -150px; left: -100px; background: {p["accent1"]}; }}
</style>

<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script>
window.__timelines = window.__timelines || {{}};
const tl = gsap.timeline({{ paused: true }});
{gsap_code}
tl.set({{}}, {{}}, {total:.1f});
window.__timelines["root"] = tl;
</script>
</body>
</html>'''


def _render_scene(scene: dict, sid: str, start: float, dur: float, is_last: bool) -> tuple[str, str]:
    stype = scene["type"]

    if stype == "title":
        title = _esc(scene["title"][:80])
        subtitle = _esc(scene.get("subtitle", "")[:120])
        badge = _esc(scene.get("badge", ""))
        h = f'''  <div id="{sid}" class="scene clip" data-start="{start:.1f}" data-duration="{dur:.1f}" data-track-index="1">
    <div class="sc">
      <div class="glow glow-1"></div>
      <span id="{sid}-badge" class="badge">{badge}</span>
      <h1 id="{sid}-title" class="title">{title}</h1>
      <p id="{sid}-sub" class="subtitle">{subtitle}</p>
    </div>
  </div>'''
        g = f'''  tl.from("#{sid}-badge", {{y: -10, opacity: 0, duration: 0.4, ease: "power2.out"}}, {start+0.2:.1f});
  tl.from("#{sid}-title", {{y: 30, opacity: 0, duration: 0.7, ease: "power3.out"}}, {start+0.4:.1f});
  tl.from("#{sid}-sub", {{y: 20, opacity: 0, duration: 0.5, ease: "power2.out"}}, {start+0.9:.1f});'''

    elif stype == "points":
        label = _esc(scene["label"])
        points = scene["points"]
        pts_html = "\n".join(
            f'      <div id="{sid}-p{j}" class="pt"><span class="pt-num">{j+1:02d}</span><span class="pt-text">{_esc(p[:90])}</span></div>'
            for j, p in enumerate(points)
        )
        h = f'''  <div id="{sid}" class="scene clip" data-start="{start:.1f}" data-duration="{dur:.1f}" data-track-index="1">
    <div class="sc">
      <div class="glow glow-2"></div>
      <span id="{sid}-label" class="label">{label}</span>
      <div style="display:flex;flex-direction:column;gap:16px;">
{pts_html}
      </div>
    </div>
  </div>'''
        g_lines = [f'  tl.from("#{sid}-label", {{x: -15, opacity: 0, duration: 0.35, ease: "power2.out"}}, {start+0.15:.2f});']
        for j in range(len(points)):
            t = start + 0.35 + j * 0.18
            g_lines.append(f'  tl.from("#{sid}-p{j}", {{x: -25, opacity: 0, duration: 0.4, ease: "power3.out"}}, {t:.2f});')
        g = "\n".join(g_lines)

    elif stype == "breakdown":
        label = _esc(scene["label"])
        sections = scene["sections"]
        # Two-column layout
        left_html = ""
        right_html = ""
        for j, sec in enumerate(sections):
            sec_name = _esc(sec.get("section", f"Part {j+1}")[:30])
            sec_points = sec.get("points", [])
            pts = "<br>".join(_esc(p[:60]) for p in sec_points[:3])
            item = f'<div id="{sid}-sec{j}" style="margin-bottom:20px;"><div class="section-title">{sec_name}</div><div class="section-pts">{pts}</div></div>'
            if j % 2 == 0:
                left_html += item
            else:
                right_html += item
        h = f'''  <div id="{sid}" class="scene clip" data-start="{start:.1f}" data-duration="{dur:.1f}" data-track-index="1">
    <div class="sc-split">
      <div>
        <span id="{sid}-label" class="label" style="margin-bottom:20px;display:block;">{label}</span>
        {left_html}
      </div>
      <div>{right_html}</div>
    </div>
  </div>'''
        g_lines = [f'  tl.from("#{sid}-label", {{y: -10, opacity: 0, duration: 0.35, ease: "power2.out"}}, {start+0.2:.2f});']
        for j in range(len(sections)):
            t = start + 0.4 + j * 0.25
            g_lines.append(f'  tl.from("#{sid}-sec{j}", {{y: 20, opacity: 0, duration: 0.45, ease: "expo.out"}}, {t:.2f});')
        g = "\n".join(g_lines)

    elif stype == "flow":
        label = _esc(scene["label"])
        steps = scene["steps"]
        steps_html = "\n".join(
            f'      <div id="{sid}-st{j}" class="pt"><span class="pt-num">→</span><span class="pt-text pt-sm">{_esc(s[:70])}</span></div>'
            for j, s in enumerate(steps)
        )
        h = f'''  <div id="{sid}" class="scene clip" data-start="{start:.1f}" data-duration="{dur:.1f}" data-track-index="1">
    <div class="sc">
      <span id="{sid}-label" class="label">{label}</span>
      <div style="display:flex;flex-direction:column;gap:14px;">
{steps_html}
      </div>
    </div>
  </div>'''
        g_lines = [f'  tl.from("#{sid}-label", {{y: -10, opacity: 0, duration: 0.35, ease: "power2.out"}}, {start+0.15:.2f});']
        for j in range(len(steps)):
            t = start + 0.35 + j * 0.15
            g_lines.append(f'  tl.from("#{sid}-st{j}", {{x: -20, opacity: 0, duration: 0.4, ease: "power3.out"}}, {t:.2f});')
        g = "\n".join(g_lines)

    elif stype == "data":
        label = _esc(scene["label"])
        items = scene["items"]
        items_html = "\n".join(
            f'      <div id="{sid}-d{j}" class="data-item"><span class="data-text">{_esc(d[:100])}</span></div>'
            for j, d in enumerate(items)
        )
        h = f'''  <div id="{sid}" class="scene clip" data-start="{start:.1f}" data-duration="{dur:.1f}" data-track-index="1">
    <div class="sc">
      <span id="{sid}-label" class="label">{label}</span>
      <div style="display:flex;flex-direction:column;gap:12px;">
{items_html}
      </div>
    </div>
  </div>'''
        g_lines = [f'  tl.from("#{sid}-label", {{y: -10, opacity: 0, duration: 0.35, ease: "power2.out"}}, {start+0.15:.2f});']
        for j in range(len(items)):
            t = start + 0.35 + j * 0.2
            g_lines.append(f'  tl.from("#{sid}-d{j}", {{x: -20, opacity: 0, duration: 0.45, ease: "power3.out"}}, {t:.2f});')
        g = "\n".join(g_lines)

    elif stype == "action":
        label = _esc(scene["label"])
        items = scene["items"]
        items_html = "\n".join(
            f'      <div id="{sid}-a{j}" class="action-item">{_esc(a[:100])}</div>'
            for j, a in enumerate(items)
        )
        h = f'''  <div id="{sid}" class="scene clip" data-start="{start:.1f}" data-duration="{dur:.1f}" data-track-index="1">
    <div class="sc">
      <div class="glow glow-1"></div>
      <span id="{sid}-label" class="label">{label}</span>
      <div style="display:flex;flex-direction:column;gap:12px;">
{items_html}
      </div>
    </div>
  </div>'''
        g_lines = [f'  tl.from("#{sid}-label", {{y: -10, opacity: 0, duration: 0.35, ease: "power2.out"}}, {start+0.15:.2f});']
        for j in range(len(items)):
            t = start + 0.4 + j * 0.22
            g_lines.append(f'  tl.from("#{sid}-a{j}", {{y: 20, opacity: 0, duration: 0.45, ease: "expo.out"}}, {t:.2f});')
        g = "\n".join(g_lines)

    elif stype == "closing":
        kws = scene.get("keywords", [])
        audience = _esc(scene.get("audience", "")[:80])
        kw_html = "\n".join(
            f'        <span id="{sid}-kw{j}" class="kw">{_esc(k)}</span>'
            for j, k in enumerate(kws)
        )
        h = f'''  <div id="{sid}" class="scene clip" data-start="{start:.1f}" data-duration="{dur:.1f}" data-track-index="1">
    <div class="sc" style="align-items:center;text-align:center;">
      <div class="glow glow-2"></div>
      <span id="{sid}-label" class="label">TOPICS</span>
      <div class="kw-grid" style="justify-content:center;">
{kw_html}
      </div>
      {f'<p id="{sid}-aud" class="subtitle" style="margin-top:16px;font-size:18px;">{audience}</p>' if audience else ''}
    </div>
  </div>'''
        g_lines = [f'  tl.from("#{sid}-label", {{opacity: 0, duration: 0.3, ease: "power2.out"}}, {start+0.15:.2f});']
        for j in range(len(kws)):
            t = start + 0.3 + j * 0.1
            g_lines.append(f'  tl.from("#{sid}-kw{j}", {{y: 10, opacity: 0, duration: 0.3, ease: "power2.out"}}, {t:.2f});')
        if audience:
            g_lines.append(f'  tl.from("#{sid}-aud", {{opacity: 0, duration: 0.4, ease: "power2.out"}}, {start+0.8:.2f});')
        # Fade out at end
        if is_last:
            fade = start + dur - 0.6
            g_lines.append(f'  tl.to("#{sid}", {{opacity: 0, duration: 0.5, ease: "power2.in"}}, {fade:.1f});')
        g = "\n".join(g_lines)

    else:
        h = ""
        g = ""

    return h, g
