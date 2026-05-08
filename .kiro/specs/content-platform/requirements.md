# Requirements Document

## Introduction

Transform the existing Content Analyzer (single-link analysis tool) into a complete **内容分析生产平台** (Content Analysis & Production Platform). The platform enables a solo content creator to perform cross-platform search, batch analysis, video generation, content planning, and history tracking — all from the web frontend at localhost:3000, eliminating the need for CLI commands.

## Glossary

- **Platform**: The Content Analysis & Production Platform web application (Next.js frontend + Python backend)
- **Analyzer**: The Python backend pipeline that fetches, extracts, and analyzes content from supported sources
- **Adapter**: A pluggable module that handles fetching and parsing content from a specific source (YouTube, Xiaohongshu)
- **Analysis_Result**: The structured output from the Analyzer containing metadata, teardown fields, keywords, hooks, and engagement signals
- **Search_Engine**: The component that queries platform adapters for content matching a keyword
- **Batch_Processor**: The component that processes multiple URLs concurrently and aggregates results
- **Video_Generator**: The component that creates HyperFrames video compositions from analysis results and renders them to MP4
- **Content_Planner**: The component that synthesizes analysis results into actionable content plans (angles, scripts, topics)
- **History_Store**: The local persistence layer that saves and retrieves past analysis results
- **Dashboard**: The overview page showing aggregated insights, recent analyses, and trends

## Requirements

### Requirement 1: Cross-Platform Search

**User Story:** As a content creator, I want to search keywords across YouTube and Xiaohongshu from the web UI, so that I can discover trending content without using the CLI.

#### Acceptance Criteria

1. WHEN a user submits a search keyword and selects a platform, THE Search_Engine SHALL return a list of matching content items within 15 seconds
2. WHEN search results are returned, THE Platform SHALL display each item with its title, author, engagement metrics (likes, comments, collects), and content type
3. WHERE the user selects a sort option (general, popular, latest), THE Search_Engine SHALL order results according to the selected sort criteria
4. WHEN a user clicks a search result item, THE Platform SHALL initiate analysis of that item's URL
5. IF the selected platform adapter does not support search, THEN THE Platform SHALL display a clear message indicating search is unavailable for that platform
6. WHEN a search is in progress, THE Platform SHALL display a loading indicator with the current search keyword

### Requirement 2: Batch Analysis

**User Story:** As a content creator, I want to analyze multiple URLs at once, so that I can efficiently research a batch of competitor content in one session.

#### Acceptance Criteria

1. WHEN a user submits multiple URLs (one per line or comma-separated), THE Batch_Processor SHALL validate each URL format before processing
2. WHEN batch processing begins, THE Platform SHALL display individual progress for each URL showing its pipeline stage (fetch, extract, analyze, report, done)
3. THE Batch_Processor SHALL process up to 5 URLs concurrently to balance speed and system resource usage
4. WHEN all URLs in a batch complete processing, THE Platform SHALL display a summary view with all results accessible individually
5. IF a single URL in the batch fails, THEN THE Batch_Processor SHALL continue processing remaining URLs and mark the failed URL with its error message
6. THE Platform SHALL accept a maximum of 20 URLs per batch submission

### Requirement 3: Video Generation from Web UI

**User Story:** As a content creator, I want to generate teardown videos directly from the web interface, so that I can produce content without running CLI commands.

#### Acceptance Criteria

1. WHEN a user triggers video generation from an analysis result, THE Video_Generator SHALL create a HyperFrames composition and render it to MP4
2. WHILE video rendering is in progress, THE Platform SHALL display a progress indicator with estimated time remaining
3. WHEN rendering completes successfully, THE Platform SHALL display an inline video player with playback controls and a download link
4. IF video rendering fails, THEN THE Platform SHALL display the error message and offer a retry option
5. THE Video_Generator SHALL complete rendering within 120 seconds for a standard analysis result

### Requirement 4: Content Planning

**User Story:** As a content creator, I want to use analysis results to generate content plans (angles, scripts, topic ideas), so that I can turn research into actionable production plans.

#### Acceptance Criteria

1. WHEN a user requests a content plan from one or more analysis results, THE Content_Planner SHALL generate a list of content angles with hook suggestions and format recommendations
2. WHEN a user selects a content angle, THE Content_Planner SHALL generate a script outline with hook, body structure, key takeaways, and CTA
3. THE Content_Planner SHALL generate topic opportunity suggestions derived from keywords, reusable angles, and adaptation ideas in the analysis results
4. WHEN multiple analysis results are provided, THE Content_Planner SHALL identify cross-content patterns and synthesize combined insights
5. THE Platform SHALL allow the user to edit and save generated content plans locally

### Requirement 5: Analysis History

**User Story:** As a content creator, I want past analyses saved automatically, so that I can reference previous research without re-running the pipeline.

#### Acceptance Criteria

1. WHEN an analysis completes successfully, THE History_Store SHALL persist the full Analysis_Result with a timestamp and source URL
2. THE Platform SHALL display a history list showing past analyses sorted by date (most recent first) with title, platform, and date
3. WHEN a user selects a history entry, THE Platform SHALL display the full analysis result identical to the original view
4. WHEN a user deletes a history entry, THE History_Store SHALL remove the entry and confirm deletion
5. THE History_Store SHALL use local file-based storage (JSON files) to maintain the local-first architecture
6. THE Platform SHALL support filtering history entries by platform (YouTube, Xiaohongshu) and by date range

### Requirement 6: Dashboard Overview

**User Story:** As a content creator, I want a dashboard showing an overview of my research activity, so that I can track patterns and identify content opportunities at a glance.

#### Acceptance Criteria

1. THE Dashboard SHALL display the total count of analyses performed, broken down by platform
2. THE Dashboard SHALL display the 5 most recent analyses with quick-access links to their full results
3. THE Dashboard SHALL display a keyword frequency summary showing the top 10 most-occurring keywords across all analyses
4. THE Dashboard SHALL display content style distribution (e.g., educational, entertainment, tutorial) as a visual breakdown
5. WHEN the user navigates to the dashboard, THE Platform SHALL load data from the History_Store and render within 2 seconds for up to 500 stored analyses

### Requirement 7: Navigation and Layout

**User Story:** As a content creator, I want a clear navigation structure, so that I can access all platform features without confusion.

#### Acceptance Criteria

1. THE Platform SHALL provide a persistent navigation bar with links to: Dashboard, Analyze (single + batch), Search, History, and Content Plans
2. WHEN the user navigates between sections, THE Platform SHALL preserve unsaved state (e.g., draft URLs, in-progress searches) within the current session
3. THE Platform SHALL use a responsive layout that functions on screen widths from 1024px to 2560px
4. THE Platform SHALL maintain the existing design language (Tailwind CSS, shadcn/ui, amber accent color)
