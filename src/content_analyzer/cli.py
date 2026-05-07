"""CLI entry point."""
import json
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

import typer
from content_analyzer.adapters.xiaohongshu import is_xiaohongshu_url
from content_analyzer.pipeline import analyze_youtube, analyze_xiaohongshu
from content_analyzer.report import render_markdown

app = typer.Typer(add_completion=False)


@app.command()
def analyze(
    url: str = typer.Argument(..., help="YouTube or Xiaohongshu URL"),
    format: str = typer.Option("json", "--format", "-f", help="Output format: json or markdown"),
    staged: bool = typer.Option(False, "--staged", help="Emit machine-readable stage events to stderr"),
):
    """Analyze a content URL and output structured JSON or Markdown report."""
    if staged:
        from content_analyzer.staged import run
        run(url)
        return

    if is_xiaohongshu_url(url):
        result = analyze_xiaohongshu(url)
    else:
        result = analyze_youtube(url)

    if format == "markdown" or format == "md":
        typer.echo(render_markdown(result))
    else:
        typer.echo(result.model_dump_json(indent=2))


if __name__ == "__main__":
    app()
