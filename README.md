# Content Analyzer

A practical tool for analyzing social-media creator resources (YouTube, Xiaohongshu) and extracting reusable insights for building a creator workflow.

## Status

- `YouTube`: metadata, transcript, optional comments → automatic analysis
- `Analysis`: deterministic heuristic by default; LLM-enhanced when `OPENAI_API_KEY` is set
- `Xiaohongshu`: single-link note extraction (text/metadata); image analysis via GPT-4o vision (recommended) or OCR fallback; multi-image posts are aggregated into a single note-level teardown

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev,full]"
```

To enable optional LLM analysis:

```bash
pip install -e ".[llm]"
```

To enable image analysis for Xiaohongshu image notes (recommended — GPT-4o vision, extracts structured creator insights):

```bash
pip install -e ".[vision]"
export OPENAI_COMPAT_BASE_URL=https://your-resource.services.ai.azure.com/openai/v1
export OPENAI_COMPAT_API_KEY=your-key
export OPENAI_COMPAT_MODEL=gpt-4o  # optional, this is the default
```

Alternative: Mistral OCR via Azure Foundry (cloud, no local engine):

```bash
export OCR_PROVIDER=mistral
export AZURE_FOUNDRY_ENDPOINT=https://your-resource.services.ai.azure.com
export AZURE_FOUNDRY_API_KEY=your-key
export AZURE_FOUNDRY_MODEL=mistral-ocr-2505-preview  # optional, this is the default
```

If no image-analysis provider is configured, the tool still works but skips image extraction and emits a warning.

Optional environment variables:

```bash
export YOUTUBE_API_KEY="your-api-key"       # enables comment fetching
export OPENAI_API_KEY="your-openai-key"     # enables LLM analysis (optional)
export OPENAI_MODEL="gpt-4o-mini"           # optional override
```

## Usage

Analyze a YouTube URL:

```bash
analyze https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

Analyze a Xiaohongshu note:

```bash
analyze https://www.xiaohongshu.com/explore/6654a3c8000000001e00a5f1
# or short links:
analyze https://xhslink.com/abc123
```

Generate a creator-friendly Markdown teardown report:

```bash
analyze https://www.youtube.com/watch?v=dQw4w9WgXcQ --format markdown
# or short flag:
analyze https://www.xiaohongshu.com/explore/6654a3c8000000001e00a5f1 -f md
```

Save a report to file:

```bash
analyze https://www.youtube.com/watch?v=dQw4w9WgXcQ -f md > teardown.md
```

Run tests:

```bash
pytest -q
```

## Output shape

The CLI returns structured JSON by default, or a creator-friendly Markdown teardown report with `--format markdown`.

JSON output includes:

- `metadata` – video title, channel, date, duration, views
- `transcript` – timestamped segments
- `comments` – top comments with like counts
- `image_analysis` – structured fields parsed from GPT-4o vision output (title, headings, key_claims, stats, cta, visual_framing, raw_text); for multi-image posts, fields are aggregated across all images with deduplication; null when not applicable
- `hook` – opening hook extracted from transcript or title
- `structure` – content sections (quartile-based or LLM-derived)
- `takeaways` – key points from comments or transcript
- `reusable_angles` – patterns worth replicating
- `keywords` – top topic keywords extracted from the content (image section labels filtered out)
- `content_style` – detected format (listicle, tutorial, narrative, review, vlog, opinion, informational; XHS-specific: industry teardown, explainer, roundup, commentary)
- `audience_intent` – inferred viewer motivation (learn, evaluate, get inspired, entertainment, stay informed)
- `engagement_hooks` – attention techniques used (question, curiosity opener, negative framing, listicle/number, storytelling, scarcity/value)
- `cta_signals` – calls to action found in the content (subscribe, follow, 点赞, 关注, etc.); placeholder outputs like 'n/a' are automatically filtered
- `adaptation_ideas` – actionable suggestions for how to imitate this content pattern for your own account (based on detected style, structure, hook, and engagement techniques)
- `warnings` – explains why a field is missing

## Analysis behavior

The analysis layer fills `hook`, `structure`, `takeaways`, `reusable_angles`, `keywords`, `content_style`, `audience_intent`, `engagement_hooks`, `cta_signals`, and `adaptation_ideas`:

1. **No API key**: uses a deterministic heuristic analyzer (keyword frequency, regex-based style/intent/hook/CTA detection, title + transcript + comment signals)
2. **With `OPENAI_API_KEY`**: sends available data to the LLM for richer analysis; falls back to heuristic on failure

All new fields degrade gracefully to `null` when input data is insufficient. The tool never crashes due to a missing API key.

## Local Workbench UI (Next.js)

A modern visual interface for running analyses and inspecting results interactively. Built with Next.js, Tailwind CSS, and shadcn/ui.

### Setup

```bash
cd web
npm install
```

### Launch

```bash
cd web
npm run dev
```

Open http://localhost:3000. The UI connects to the Python analyzer via a local API route — the Python venv must be set up at the project root (see Setup above).

Features:
- Paste a YouTube or Xiaohongshu URL and trigger analysis
- Visual pipeline progress indicator (Input → Fetch → Extract → Analyze → Report → Done)
- Browse results across tabs: Teardown, Image Analysis, Raw JSON
- Warnings displayed inline
- Modern minimalist design — research-desk aesthetic, no clutter

The UI calls the existing `analyze` CLI under the hood — no Python logic is duplicated.

### Legacy Streamlit UI

The original Streamlit UI is still available:

```bash
pip install -e ".[ui]"
streamlit run src/content_analyzer/ui.py
```

## Next phase

- Add local media ingestion
- Richer heuristic rules (sentiment, bigram extraction)
- Platform-specific engagement benchmarks
