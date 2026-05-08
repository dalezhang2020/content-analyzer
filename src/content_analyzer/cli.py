"""CLI entry point."""
import json
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

import typer
from content_analyzer.adapters.registry import detect_platform, get_adapter, doctor as adapter_doctor
from content_analyzer.pipeline import analyze_url, search as pipeline_search
from content_analyzer.report import render_markdown

app = typer.Typer(add_completion=False)


@app.command()
def analyze(
    url: str = typer.Argument(..., help="YouTube or Xiaohongshu URL"),
    format: str = typer.Option("json", "--format", "-f", help="Output format: json or markdown"),
    staged: bool = typer.Option(False, "--staged", help="Emit machine-readable stage events to stderr"),
    video: bool = typer.Option(False, "--video", "-v", help="Generate a HyperFrames video from analysis"),
    video_output: Optional[str] = typer.Option(None, "--video-output", help="Output directory for video (default: ./video-output)"),
    render: bool = typer.Option(True, "--render/--no-render", help="Render to MP4 after generating HTML"),
):
    """Analyze a content URL and output structured JSON or Markdown report."""
    if staged:
        from content_analyzer.staged import run
        run(url)
        return

    result = analyze_url(url)

    # Video generation mode
    if video:
        from content_analyzer.video import generate_video_composition, render_video

        out_dir = Path(video_output) if video_output else Path("./video-output")
        typer.echo(f"Generating video composition in {out_dir}/", err=True)

        index_path = generate_video_composition(result, out_dir)
        typer.echo(f"  ✓ Composition: {index_path}", err=True)

        if render:
            typer.echo("  Rendering to MP4...", err=True)
            try:
                mp4_path = render_video(out_dir)
                if mp4_path:
                    typer.echo(f"  ✓ Video: {mp4_path}", err=True)
                else:
                    typer.echo("  ✗ Render produced no output", err=True)
            except RuntimeError as e:
                typer.echo(f"  ✗ Render failed: {e}", err=True)
        else:
            typer.echo("  Skipped rendering (--no-render). Run manually:", err=True)
            typer.echo(f"    npx hyperframes render --output output.mp4", err=True)
            typer.echo(f"    (in {out_dir}/)", err=True)
        return

    if format == "markdown" or format == "md":
        typer.echo(render_markdown(result))
    else:
        typer.echo(result.model_dump_json(indent=2))

    # Display token usage summary
    usage = result.token_usage
    if usage.total_tokens > 0:
        typer.echo("\n--- Token Usage ---", err=True)
        if usage.vision_prompt_tokens or usage.vision_completion_tokens:
            typer.echo(f"  Vision:   {usage.vision_prompt_tokens:,} prompt + {usage.vision_completion_tokens:,} completion = {usage.vision_prompt_tokens + usage.vision_completion_tokens:,}", err=True)
        if usage.analysis_prompt_tokens or usage.analysis_completion_tokens:
            typer.echo(f"  Analysis: {usage.analysis_prompt_tokens:,} prompt + {usage.analysis_completion_tokens:,} completion = {usage.analysis_prompt_tokens + usage.analysis_completion_tokens:,}", err=True)
        typer.echo(f"  Total:    {usage.total_prompt_tokens:,} prompt + {usage.total_completion_tokens:,} completion = {usage.total_tokens:,} tokens", err=True)


@app.command(name="search")
def search_cmd(
    keyword: str = typer.Argument(..., help="Search keyword"),
    platform: str = typer.Option("xiaohongshu", "--platform", "-p", help="Platform: xiaohongshu, youtube"),
    page: int = typer.Option(1, "--page", help="Page number"),
    sort: str = typer.Option("general", "--sort", "-s", help="Sort: general, popular, latest"),
    format: str = typer.Option("json", "--format", "-f", help="Output format: json or table"),
):
    """Search for content on a platform by keyword."""
    response = pipeline_search(keyword, platform=platform, page=page, sort=sort)

    if response.warnings:
        for w in response.warnings:
            typer.echo(f"⚠ {w}", err=True)

    if format == "table":
        typer.echo(f"\n{'#':<3} {'Title':<50} {'Author':<15} {'Likes':<8} {'Type':<8}")
        typer.echo("-" * 90)
        for i, item in enumerate(response.items, 1):
            title = item.title[:47] + "..." if len(item.title) > 50 else item.title
            author = (item.author or "")[:12]
            typer.echo(f"{i:<3} {title:<50} {author:<15} {item.likes:<8} {item.content_type:<8}")
        typer.echo(f"\nTotal: {response.total} results")
    else:
        # JSON output
        output = {
            "keyword": response.keyword,
            "platform": response.platform,
            "total": response.total,
            "items": [
                {
                    "note_id": item.note_id,
                    "title": item.title,
                    "url": item.url,
                    "author": item.author,
                    "likes": item.likes,
                    "content_type": item.content_type,
                    "snippet": item.snippet,
                }
                for item in response.items
            ],
            "warnings": response.warnings,
        }
        typer.echo(json.dumps(output, indent=2, ensure_ascii=False))


@app.command(name="doctor")
def doctor_cmd():
    """Check health of all platform adapters."""
    typer.echo("Content Analyzer — Adapter Health Check\n")
    results = adapter_doctor()
    all_ok = True
    for name, (ok, msg) in results.items():
        icon = "✓" if ok else "✗"
        color = typer.colors.GREEN if ok else typer.colors.RED
        typer.echo(f"  {icon} {name}: ", nl=False)
        typer.echo(msg, color=color)
        if not ok:
            all_ok = False

    typer.echo("")
    if all_ok:
        typer.echo("All adapters healthy.")
    else:
        typer.echo("Some adapters have issues. See above for details.")


if __name__ == "__main__":
    app()
