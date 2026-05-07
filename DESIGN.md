# Content Analyzer — Design System

## Principles

1. **Research desk** — the UI feels like a well-organized workspace, not a marketing page.
2. **Restrained palette** — neutral base (stone/zinc), one accent color (warm amber/ochre), no blue-purple AI gradients.
3. **Strong typography** — clear hierarchy via weight and size, not color or decoration.
4. **No clutter** — every element earns its space. No card grids, no glassmorphism, no gradient text.
5. **Intentional motion** — subtle transitions for pipeline progress; no gratuitous animation.

## Palette

| Role       | Value              |
|------------|--------------------|
| Background | `stone-50` / white |
| Surface    | `stone-100`        |
| Border     | `stone-200`        |
| Text       | `stone-900`        |
| Muted text | `stone-500`        |
| Accent     | `amber-600`        |
| Success    | `emerald-600`      |
| Warning    | `amber-500`        |
| Error      | `red-600`          |

## Typography

- Headings: Inter, semibold, tight tracking
- Body: Inter, regular, relaxed leading
- Mono: JetBrains Mono for code/JSON

## Layout

- Max content width: 768px centered
- Generous vertical rhythm (space-y-8 between sections)
- Pipeline visualization: horizontal step indicator with connecting lines

## Components

- **URL Input**: full-width, large, minimal border, placeholder text
- **Pipeline Steps**: horizontal row of labeled circles/dots connected by lines; active step pulses subtly
- **Result Sections**: stacked blocks with clear headings, no cards — just typographic separation
- **Tabs**: underline-style, not boxed

## Anti-patterns (do not use)

- Blue/purple gradient backgrounds
- Glassmorphism or frosted glass
- Gradient text
- Dense card grids
- Floating action buttons
- Excessive iconography
- "AI-powered" badge aesthetics
