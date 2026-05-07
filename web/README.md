# Content Analyzer — Web UI

A local creator workbench for analyzing social-media content. Paste a YouTube or Xiaohongshu URL, watch the real-time analysis pipeline, and use the results to generate content angles, scripts, and topic ideas.

## Prerequisites

- Node.js 18+
- The Python analyzer venv set up in the parent directory (see root README)

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Usage

1. Paste a YouTube or Xiaohongshu URL into the input field.
2. Click **Analyze** — the pipeline indicator shows real-time progress as the backend fetches, extracts, and analyzes the content.
3. Browse results across tabs:
   - **Teardown** — structured breakdown: hook, structure, keywords, engagement hooks, CTAs, reusable angles.
   - **Actions** — creator workbench panel with content angles, script starters, and topic opportunity ideas derived from the analysis.
   - **Images** — visual/thumbnail analysis (when available).
   - **JSON** — raw analysis output.

## Architecture

- `src/app/page.tsx` — main page with streaming pipeline consumer
- `src/app/api/analyze/route.ts` — API route that spawns the Python CLI and streams stage updates as NDJSON
- `src/components/pipeline-view.tsx` — horizontal step indicator driven by backend stage events
- `src/components/results-view.tsx` — tabbed results layout
- `src/components/action-panel.tsx` — creator action panel (angles, scripts, topics)

## Design

Follows the project design system: warm stone palette, amber accent, editorial research-desk aesthetic. No blue/purple gradients, no clutter. See `/DESIGN.md` for full spec.

## Build

```bash
npm run build
```
