# Technical Design: Content Analysis & Production Platform

## Overview

Transform the single-page Content Analyzer into a multi-page platform with persistent navigation, local storage, and full frontend access to all backend capabilities (search, batch analysis, video generation, content planning).

**Architecture**: Next.js App Router (frontend) → API Routes → Python subprocess (backend). Local-first, no external database.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Next.js Frontend                          │
│                                                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────┐ │
│  │Dashboard │ │ Analyze  │ │  Search  │ │ History  │ │ Plans │ │
│  │  Page    │ │  Page    │ │  Page    │ │  Page    │ │ Page  │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬───┘ │
│       │             │            │             │           │     │
│  ┌────┴─────────────┴────────────┴─────────────┴───────────┴───┐ │
│  │                    Shared Layout + Nav                        │ │
│  └──────────────────────────────────────────────────────────────┘ │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTP (fetch)
┌───────────────────────────────┴─────────────────────────────────┐
│                     Next.js API Routes                            │
│                                                                   │
│  /api/analyze    — single URL analysis (streaming NDJSON)         │
│  /api/batch      — batch URL analysis (streaming)                 │
│  /api/search     — keyword search across platforms                │
│  /api/video      — generate + render video                        │
│  /api/history    — CRUD for analysis history                      │
│  /api/plans      — CRUD for content plans                         │
│  /api/dashboard  — aggregated stats from history                  │
└───────────────────────────────┬─────────────────────────────────┘
                                │ subprocess / fs
┌───────────────────────────────┴─────────────────────────────────┐
│                     Python Backend                                │
│                                                                   │
│  content_analyzer.pipeline.analyze_url()                          │
│  content_analyzer.pipeline.search()                               │
│  content_analyzer.video.generate_video_composition()              │
│  content_analyzer.video.render_video()                            │
└─────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────┴─────────────────────────────────┐
│                     Local File Storage                            │
│                                                                   │
│  web/data/history/    — JSON files per analysis                   │
│  web/data/plans/      — JSON files per content plan               │
│  web/public/videos/   — rendered MP4 files                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Page Structure (App Router)

```
web/src/app/
├── layout.tsx              — Root layout with persistent sidebar nav
├── page.tsx                — Dashboard (home page)
├── analyze/
│   └── page.tsx            — Single + Batch analysis
├── search/
│   └── page.tsx            — Cross-platform search
├── history/
│   ├── page.tsx            — History list
│   └── [id]/
│       └── page.tsx        — Single history entry detail
├── plans/
│   ├── page.tsx            — Content plans list
│   └── [id]/
│       └── page.tsx        — Single plan editor
└── api/
    ├── analyze/route.ts    — (existing) single URL
    ├── batch/route.ts      — batch URL processing
    ├── search/route.ts     — keyword search
    ├── video/route.ts      — (existing) video generation
    ├── history/route.ts    — GET list, POST save, DELETE
    ├── history/[id]/route.ts — GET single, DELETE single
    ├── plans/route.ts      — GET list, POST create
    ├── plans/[id]/route.ts — GET, PUT, DELETE single plan
    └── dashboard/route.ts  — GET aggregated stats
```

---

## Component Design

### Shared Layout (`layout.tsx`)

```
┌─────────────────────────────────────────────────────────┐
│ ┌─────────┐                                             │
│ │  Logo   │  Content Analyzer                           │
│ ├─────────┤                                             │
│ │ 📊 Dashboard                                          │
│ │ 🔍 Search                                             │
│ │ 📝 Analyze                                            │
│ │ 📁 History                                            │
│ │ 📋 Plans                                              │
│ ├─────────┤                                             │
│ │ Status  │  ┌────────────────────────────────────────┐ │
│ │ • YT ✓  │  │                                        │ │
│ │ • XHS ✓ │  │         Page Content Area              │ │
│ │         │  │                                        │ │
│ └─────────┘  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

- Sidebar: 200px fixed width, collapsible on smaller screens
- Shows adapter health status at bottom (from `/api/dashboard`)
- Active page highlighted with amber accent

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `Sidebar` | `components/sidebar.tsx` | Persistent navigation |
| `SearchPanel` | `components/search-panel.tsx` | Keyword input + platform selector + results grid |
| `BatchInput` | `components/batch-input.tsx` | Multi-URL textarea + validation + progress |
| `AnalysisCard` | `components/analysis-card.tsx` | Compact card for search results / history items |
| `VideoPlayer` | `components/video-player.tsx` | Inline MP4 player with controls + download |
| `PlanEditor` | `components/plan-editor.tsx` | Editable content plan with sections |
| `StatsCard` | `components/stats-card.tsx` | Dashboard metric card |
| `KeywordCloud` | `components/keyword-cloud.tsx` | Top keywords visualization |
| `ResultsView` | `components/results-view.tsx` | (existing) Full analysis display |
| `ActionPanel` | `components/action-panel.tsx` | (existing) Content angles + video |

---

## API Design

### `POST /api/search`

**Request:**
```json
{
  "keyword": "AI编程",
  "platform": "xiaohongshu",
  "sort": "popular",
  "page": 1
}
```

**Response:**
```json
{
  "keyword": "AI编程",
  "platform": "xiaohongshu",
  "total": 20,
  "items": [
    {
      "note_id": "abc123",
      "title": "10个AI编程工具推荐",
      "url": "https://www.xiaohongshu.com/explore/abc123?xsec_token=...",
      "author": "创作者",
      "likes": 5200,
      "content_type": "normal"
    }
  ],
  "warnings": []
}
```

**Backend call:** `pipeline.search(keyword, platform, page, sort)` via subprocess.

### `POST /api/batch`

**Request:**
```json
{
  "urls": [
    "https://www.xiaohongshu.com/explore/abc",
    "https://youtube.com/watch?v=xyz"
  ]
}
```

**Response:** Streaming NDJSON, one line per event:
```jsonl
{"url": "https://...", "status": "processing", "stage": "fetch"}
{"url": "https://...", "status": "processing", "stage": "analyze"}
{"url": "https://...", "status": "done", "result": {...}}
{"url": "https://...", "status": "error", "error": "..."}
{"summary": {"total": 2, "success": 1, "failed": 1}}
```

**Backend:** Spawns up to 5 concurrent Python processes.

### `GET/POST/DELETE /api/history`

**Storage:** `web/data/history/{id}.json`

Each file:
```json
{
  "id": "h_1715000000000",
  "url": "https://...",
  "platform": "xiaohongshu",
  "analyzedAt": "2026-05-08T12:00:00Z",
  "result": { /* full AnalysisResult */ }
}
```

- `GET /api/history` — list all (with pagination, filter by platform/date)
- `GET /api/history/[id]` — get single entry
- `POST /api/history` — save new entry (called automatically after analysis)
- `DELETE /api/history/[id]` — delete entry

### `GET/POST/PUT/DELETE /api/plans`

**Storage:** `web/data/plans/{id}.json`

Each file:
```json
{
  "id": "p_1715000000000",
  "title": "AI编程内容计划",
  "createdAt": "2026-05-08T12:00:00Z",
  "updatedAt": "2026-05-08T14:00:00Z",
  "sourceAnalyses": ["h_123", "h_456"],
  "angles": [
    { "title": "...", "hook": "...", "format": "..." }
  ],
  "script": "HOOK:\n...\nBODY:\n...",
  "topics": ["...", "..."],
  "notes": "user free-text notes"
}
```

### `GET /api/dashboard`

**Response:**
```json
{
  "totalAnalyses": 42,
  "byPlatform": { "xiaohongshu": 30, "youtube": 12 },
  "recentAnalyses": [ /* last 5 history entries (summary only) */ ],
  "topKeywords": [
    { "keyword": "AI", "count": 15 },
    { "keyword": "编程", "count": 12 }
  ],
  "styleDistribution": {
    "tutorial": 8,
    "roundup": 6,
    "explainer": 5,
    "review": 3
  },
  "adapterHealth": {
    "youtube": { "ok": true, "message": "..." },
    "xiaohongshu": { "ok": true, "message": "..." }
  }
}
```

**Implementation:** Reads all files from `web/data/history/`, aggregates in-memory. For ≤500 files this is fast enough (<2s).

---

## Data Flow

### Single Analysis Flow (enhanced)

```
User enters URL → POST /api/analyze (existing, streaming)
                → On completion: POST /api/history (auto-save)
                → Display ResultsView
                → User can: Generate Video | Create Plan | Batch more
```

### Search → Analyze Flow

```
User enters keyword → POST /api/search
                    → Display results grid
                    → User clicks item → POST /api/analyze (with item URL)
                    → Auto-save to history
```

### Batch Flow

```
User pastes URLs → POST /api/batch (streaming)
                 → Display per-URL progress
                 → Each success → POST /api/history (auto-save)
                 → Display summary with links to each result
```

---

## Local Storage Design

```
web/
├── data/                    — gitignored, local-only
│   ├── history/             — one JSON per analysis
│   │   ├── h_1715000000001.json
│   │   ├── h_1715000000002.json
│   │   └── ...
│   └── plans/               — one JSON per content plan
│       ├── p_1715000000001.json
│       └── ...
└── public/
    └── videos/              — rendered MP4s (gitignored)
        ├── video-1715000000001.mp4
        └── ...
```

**ID generation:** `{prefix}_{Date.now()}` — simple, sortable, no collisions at human speed.

**Cleanup:** Videos older than 7 days can be auto-deleted on server start (optional, not MVP).

---

## Frontend State Management

No external state library needed. Each page manages its own state with React hooks:

- **Dashboard**: `useEffect` fetch on mount from `/api/dashboard`
- **Search**: `useState` for keyword/platform/results, fetch on submit
- **Analyze**: existing streaming logic (already works), add auto-save on completion
- **History**: `useEffect` fetch list, client-side filter/sort
- **Plans**: `useEffect` fetch list, individual plan pages fetch by ID

Cross-page communication (e.g., "analyze this search result"):
- Use URL query params: `/analyze?url=https://...`
- No global store needed

---

## Migration Plan

### Phase 1: Layout + Navigation (Req 7)
- Add sidebar layout
- Move existing page.tsx content to `/analyze`
- Create placeholder pages for all routes

### Phase 2: History (Req 5)
- Add `/api/history` routes
- Add auto-save after analysis
- Build history list page

### Phase 3: Search (Req 1)
- Add `/api/search` route
- Build search page with results grid
- Wire "analyze" action from search results

### Phase 4: Batch Analysis (Req 2)
- Add `/api/batch` route
- Add batch input UI to analyze page
- Streaming progress per URL

### Phase 5: Dashboard (Req 6)
- Add `/api/dashboard` route
- Build dashboard page with stats cards + keyword cloud

### Phase 6: Content Planning (Req 4)
- Add `/api/plans` routes
- Build plan editor page
- Wire "create plan" from analysis results

### Phase 7: Video Enhancement (Req 3)
- Already partially done
- Add progress indicator
- Ensure auto-play + download works reliably

---

## Technology Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| State management | React hooks (no Redux/Zustand) | Simple enough for single-user local app |
| Storage | JSON files on disk | Local-first, no DB setup, easy to backup/inspect |
| Routing | Next.js App Router | Already in use, supports layouts natively |
| Streaming | NDJSON over fetch ReadableStream | Already proven in existing analyze route |
| Styling | Tailwind CSS 4 + shadcn/ui | Already in use, consistent design |
| Icons | lucide-react | Already installed |
| Backend communication | subprocess spawn | Already proven, no need for FastAPI server |

---

## Non-Functional Considerations

- **Performance**: Dashboard aggregation over 500 JSON files should complete in <2s (Node.js `fs.readdir` + `JSON.parse` is fast for small files)
- **Disk usage**: Each history entry ~5-10KB JSON. 500 entries = ~5MB. Videos are larger (~700KB each) but auto-cleaned.
- **Concurrency**: Batch processing limited to 5 concurrent subprocesses to avoid overwhelming the machine (M4 Pro has 14 cores, 5 is conservative)
- **Error resilience**: Each API route has timeout handling. Failed analyses don't block the UI.
