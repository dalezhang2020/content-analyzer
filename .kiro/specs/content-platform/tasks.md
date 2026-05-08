# Implementation Plan: Content Analysis & Production Platform

## Overview

Transform the single-page Content Analyzer into a multi-page platform following the 7-phase migration plan. Each phase builds incrementally on the previous, starting with layout/navigation and ending with video enhancement. The implementation uses Next.js App Router, React 19, TypeScript, Tailwind CSS 4, and shadcn/ui.

## Tasks

- [x] 1. Layout + Navigation (Phase 1)
  - [x] 1.1 Create the Sidebar component with navigation links
    - Create `web/src/components/sidebar.tsx` with links to Dashboard, Search, Analyze, History, Plans
    - Use lucide-react icons, amber accent for active state
    - Sidebar should be 200px fixed width, collapsible on smaller screens (< 1024px)
    - Show adapter health status placeholder at bottom
    - _Requirements: 7.1, 7.4_

  - [x] 1.2 Refactor root layout to use sidebar navigation
    - Update `web/src/app/layout.tsx` to include the Sidebar component
    - Create a shared layout with sidebar + main content area
    - Ensure responsive behavior for 1024px–2560px screen widths
    - _Requirements: 7.1, 7.3, 7.4_

  - [x] 1.3 Move existing analyze page and create placeholder pages
    - Move current `web/src/app/page.tsx` content to `web/src/app/analyze/page.tsx`
    - Create `web/src/app/page.tsx` as Dashboard placeholder
    - Create `web/src/app/search/page.tsx` placeholder
    - Create `web/src/app/history/page.tsx` placeholder
    - Create `web/src/app/plans/page.tsx` placeholder
    - _Requirements: 7.1_

  - [x] 1.4 Write unit tests for Sidebar navigation and layout
    - Test active link highlighting
    - Test responsive collapse behavior
    - _Requirements: 7.1, 7.3_

- [x] 2. Checkpoint - Ensure layout and navigation work
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. History (Phase 2)
  - [x] 3.1 Create history data storage utilities
    - Create `web/src/lib/history.ts` with functions: `saveHistory`, `getHistory`, `getHistoryById`, `deleteHistory`, `listHistory`
    - Use `web/data/history/` directory with JSON files
    - ID format: `h_{Date.now()}`
    - Support filtering by platform and date range
    - _Requirements: 5.1, 5.5, 5.6_

  - [x] 3.2 Create history API routes
    - Create `web/src/app/api/history/route.ts` with GET (list with pagination/filter) and POST (save new entry)
    - Create `web/src/app/api/history/[id]/route.ts` with GET (single) and DELETE
    - Input validation: sanitize IDs, validate platform filter values
    - _Requirements: 5.1, 5.4, 5.5, 5.6_

  - [x] 3.3 Add auto-save to existing analyze flow
    - Modify the analyze page to call POST `/api/history` after successful analysis completion
    - Save full AnalysisResult with timestamp, URL, and platform
    - _Requirements: 5.1_

  - [x] 3.4 Build the History list page
    - Create `web/src/app/history/page.tsx` with list of past analyses
    - Display title, platform, date for each entry, sorted by most recent first
    - Add platform filter dropdown and date range filter
    - Add delete button with confirmation
    - _Requirements: 5.2, 5.4, 5.6_

  - [x] 3.5 Build the History detail page
    - Create `web/src/app/history/[id]/page.tsx`
    - Display full analysis result using existing `ResultsView` component
    - _Requirements: 5.3_

  - [x] 3.6 Write unit tests for history utilities and API routes
    - Test save/load/delete operations
    - Test filtering by platform and date range
    - Test error handling for missing files
    - _Requirements: 5.1, 5.4, 5.5, 5.6_

- [x] 4. Checkpoint - Ensure history feature works end-to-end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Search (Phase 3)
  - [x] 5.1 Create the search API route
    - Create `web/src/app/api/search/route.ts`
    - Accept POST with `keyword`, `platform`, `sort`, `page`
    - Call Python backend via subprocess: `pipeline.search(keyword, platform, page, sort)`
    - Return structured results with title, author, engagement metrics, content type
    - Add 15-second timeout
    - Input validation: keyword length limit, platform enum check, sort enum check
    - _Requirements: 1.1, 1.2, 1.3, 1.5_

  - [x] 5.2 Build the SearchPanel component
    - Create `web/src/components/search-panel.tsx`
    - Keyword input field, platform selector (YouTube, Xiaohongshu), sort dropdown (general, popular, latest)
    - Loading indicator during search with current keyword displayed
    - _Requirements: 1.1, 1.3, 1.6_

  - [x] 5.3 Build the Search results page
    - Create `web/src/app/search/page.tsx` using SearchPanel
    - Display results in a grid with AnalysisCard components
    - Each card shows title, author, likes, comments, collects, content type
    - Clicking a result navigates to `/analyze?url={item_url}`
    - Show "search unavailable" message if platform doesn't support search
    - _Requirements: 1.2, 1.4, 1.5_

  - [x] 5.4 Create the AnalysisCard component
    - Create `web/src/components/analysis-card.tsx`
    - Compact card showing title, author, engagement metrics, platform badge
    - Reusable across search results and history list
    - _Requirements: 1.2_

  - [x] 5.5 Write unit tests for search API and components
    - Test search request validation
    - Test timeout handling
    - Test platform-not-supported error display
    - _Requirements: 1.1, 1.5, 1.6_

- [x] 6. Checkpoint - Ensure search feature works
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Batch Analysis (Phase 4)
  - [x] 7.1 Create the batch API route with streaming
    - Create `web/src/app/api/batch/route.ts`
    - Accept POST with `urls` array (max 20)
    - Validate each URL format before processing
    - Spawn up to 5 concurrent Python subprocesses
    - Stream NDJSON events: `{url, status, stage}` for progress, `{url, status, result}` for completion, `{url, status, error}` for failures
    - Auto-save each successful result to history
    - Continue processing remaining URLs if one fails
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 7.2 Build the BatchInput component
    - Create `web/src/components/batch-input.tsx`
    - Multi-line textarea for URLs (one per line or comma-separated)
    - URL validation with inline error indicators
    - Max 20 URLs enforcement with counter display
    - Submit button
    - _Requirements: 2.1, 2.6_

  - [x] 7.3 Add batch UI to the Analyze page
    - Update `web/src/app/analyze/page.tsx` with tabs: "Single URL" and "Batch"
    - Batch tab uses BatchInput component
    - Display per-URL progress showing pipeline stage (fetch, extract, analyze, report, done)
    - Show summary view on completion with links to individual results
    - Mark failed URLs with error messages
    - _Requirements: 2.2, 2.4, 2.5_

  - [x] 7.4 Write unit tests for batch processing
    - Test URL validation
    - Test max 20 URL limit
    - Test concurrent processing limit (5)
    - Test partial failure handling
    - _Requirements: 2.1, 2.3, 2.5, 2.6_

- [x] 8. Checkpoint - Ensure batch analysis works
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Dashboard (Phase 5)
  - [x] 9.1 Create the dashboard API route
    - Create `web/src/app/api/dashboard/route.ts`
    - Read all history files, aggregate: total count by platform, top 10 keywords, style distribution, recent 5 analyses
    - Include adapter health check
    - Ensure <2s response for up to 500 history entries
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 9.2 Build dashboard stat components
    - Create `web/src/components/stats-card.tsx` for metric display (total analyses, platform breakdown)
    - Create `web/src/components/keyword-cloud.tsx` for top 10 keywords visualization
    - _Requirements: 6.1, 6.3_

  - [x] 9.3 Build the Dashboard page
    - Update `web/src/app/page.tsx` (home page) with full dashboard
    - Display total analyses by platform using StatsCard
    - Display 5 most recent analyses with quick-access links
    - Display keyword frequency summary (top 10)
    - Display content style distribution as visual breakdown (bar chart or pie)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 9.4 Write unit tests for dashboard aggregation
    - Test keyword counting logic
    - Test style distribution calculation
    - Test performance with large history sets
    - _Requirements: 6.1, 6.3, 6.4, 6.5_

- [x] 10. Checkpoint - Ensure dashboard works
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Content Planning (Phase 6)
  - [x] 11.1 Create content plans storage utilities
    - Create `web/src/lib/plans.ts` with functions: `createPlan`, `getPlan`, `updatePlan`, `deletePlan`, `listPlans`
    - Use `web/data/plans/` directory with JSON files
    - ID format: `p_{Date.now()}`
    - Plan schema: id, title, createdAt, updatedAt, sourceAnalyses, angles, script, topics, notes
    - _Requirements: 4.5_

  - [x] 11.2 Create content plans API routes
    - Create `web/src/app/api/plans/route.ts` with GET (list) and POST (create plan from analysis results)
    - Create `web/src/app/api/plans/[id]/route.ts` with GET, PUT (update), DELETE
    - POST should call Python backend to generate angles, script outline, and topic suggestions from source analyses
    - Input validation: validate sourceAnalyses IDs exist, sanitize text fields
    - _Requirements: 4.1, 4.2, 4.3, 4.5_

  - [x] 11.3 Build the PlanEditor component
    - Create `web/src/components/plan-editor.tsx`
    - Editable sections: title, angles list, script outline (hook/body/takeaways/CTA), topics, free-text notes
    - Auto-save on edit (debounced PUT to API)
    - _Requirements: 4.2, 4.5_

  - [x] 11.4 Build the Plans list page
    - Create `web/src/app/plans/page.tsx` with list of saved plans
    - Display title, creation date, source count
    - "New Plan" button that prompts for source analyses selection
    - _Requirements: 4.5_

  - [x] 11.5 Build the Plan detail/editor page
    - Create `web/src/app/plans/[id]/page.tsx` using PlanEditor component
    - Load plan data, display editable content
    - Show cross-content patterns when multiple sources are used
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 11.6 Wire "Create Plan" action from analysis results
    - Add "Create Content Plan" button to ResultsView/ActionPanel
    - Navigate to plans page with pre-selected source analysis
    - _Requirements: 4.1_

  - [x] 11.7 Write unit tests for content planning
    - Test plan CRUD operations
    - Test plan generation from analysis results
    - Test edit/save flow
    - _Requirements: 4.1, 4.5_

- [x] 12. Checkpoint - Ensure content planning works
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Video Enhancement (Phase 7)
  - [x] 13.1 Add video progress indicator
    - Update the video generation flow in ActionPanel to show progress with estimated time remaining
    - Use streaming or polling to track render progress
    - _Requirements: 3.2_

  - [x] 13.2 Build the VideoPlayer component
    - Create `web/src/components/video-player.tsx`
    - Inline MP4 player with playback controls (play/pause, seek, volume)
    - Download link for the rendered video
    - Auto-play on render completion
    - _Requirements: 3.3_

  - [x] 13.3 Add error handling and retry for video generation
    - Display error message when rendering fails
    - Add retry button that re-triggers the generation
    - Enforce 120-second timeout
    - _Requirements: 3.4, 3.5_

  - [x] 13.4 Wire VideoPlayer into the analysis results flow
    - Replace any existing video display with the new VideoPlayer component
    - Show VideoPlayer inline after successful generation
    - _Requirements: 3.1, 3.3_

  - [x] 13.5 Write unit tests for video enhancement
    - Test progress indicator updates
    - Test error/retry flow
    - Test timeout enforcement
    - _Requirements: 3.2, 3.4, 3.5_

- [x] 14. Final checkpoint - Ensure all features work together
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Session state preservation and final wiring
  - [x] 15.1 Implement session state preservation across navigation
    - Ensure draft URLs, in-progress searches, and form state persist when navigating between pages
    - Use URL query params for cross-page communication (e.g., `/analyze?url=...`)
    - _Requirements: 7.2_

  - [x] 15.2 Update Sidebar with adapter health status
    - Fetch adapter health from `/api/dashboard` and display in sidebar footer
    - Show green/red indicators for YouTube and Xiaohongshu adapters
    - _Requirements: 7.1_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation between phases
- The existing `/api/analyze` and `/api/video` routes are already implemented — new tasks build on top of them
- Local file storage in `web/data/` should be gitignored
- All API inputs must be sanitized (length limits, type checks, control character filtering) per project conventions

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4"] },
    { "id": 2, "tasks": ["3.1", "5.4"] },
    { "id": 3, "tasks": ["3.2", "3.4", "5.1"] },
    { "id": 4, "tasks": ["3.3", "3.5", "3.6", "5.2"] },
    { "id": 5, "tasks": ["5.3", "5.5"] },
    { "id": 6, "tasks": ["7.1", "7.2"] },
    { "id": 7, "tasks": ["7.3", "7.4"] },
    { "id": 8, "tasks": ["9.1", "11.1"] },
    { "id": 9, "tasks": ["9.2", "9.3", "11.2"] },
    { "id": 10, "tasks": ["9.4", "11.3", "11.4"] },
    { "id": 11, "tasks": ["11.5", "11.6", "11.7"] },
    { "id": 12, "tasks": ["13.1", "13.2"] },
    { "id": 13, "tasks": ["13.3", "13.4", "13.5"] },
    { "id": 14, "tasks": ["15.1", "15.2"] }
  ]
}
```
