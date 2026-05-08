---
inclusion: fileMatch
fileMatchPattern: "**/*.html,**/plans/**,**/video.py,**/generate-html/**"
---

# HTML Design Skills

When generating HTML artifacts (slide decks, animations, posters, landing pages, diagrams, reports), follow these design principles sourced from industry-leading skills:

## Core Principles (from claude-design-skill)

### 1. Commit to a visual system before building
Declare upfront:
- Type scale (e.g., 13px → 20px → 36px → 72px)
- 1-2 background colors
- Layout rhythm
- Section header pattern

Consistency comes from a system, not from restraint in the moment.

### 2. Avoid AI-design slop
- **No aggressive gradient backgrounds** — prefer solid colors with localized accents
- **No emoji bullets** (unless the brand uses them)
- **No rounded-corner cards with left-border accent stripes** (AI cliché)
- **No overused fonts**: Inter, Roboto, Arial, system fonts (unless brand-mandated)
- **No SVG silhouettes** as substitutes for real product shots — use labeled placeholders

### 3. Respect scale floors
- 1920×1080 slides: body text ≥ 24px
- Print documents: ≥ 12pt
- Mobile hit targets: ≥ 44px

These are **minima**, not starting points.

### 4. Placeholders over fakes
Missing an icon, photo, or logo? Use a labeled placeholder like `[hero image: product on gradient]`. A placeholder is honest; a bad attempt at the real thing is lying.

### 5. No filler content
Never pad designs with dummy sections, lorem-ipsum, or decorative stats. If a section feels empty, solve it with layout and composition, not invented content.

## Output Format Selection

| Exploring... | Use... |
|---|---|
| Visual options (color, type, static layout) | Design canvas with labeled variants |
| Interactions, flows | Hi-fi clickable prototype |
| Narrative sequence | Slide deck with pagination |
| Motion, transitions, video | Timeline animation (Stage + Sprite) |
| Rough ideas early | Wireframe grid / storyboard |

## Diagram Types (from diagram-design)

For architecture/flow diagrams, use SELF-CONTAINED HTML + SVG (never Mermaid). The 13 editorial types:

1. **Comparison matrix** — side-by-side with clear criteria
2. **Hierarchy tree** — parent/child relationships
3. **Timeline** — temporal sequence
4. **Flow** — step-by-step process
5. **Network** — interconnected nodes
6. **Quadrant** — 2-axis categorization
7. **Funnel** — conversion/filtering
8. **Venn** — set overlaps
9. **Architecture** — system components
10. **Pyramid** — layered hierarchy
11. **Cycle** — circular process
12. **Org chart** — reporting structure
13. **Journey map** — user experience flow

Design principles for diagrams:
- NO drop shadows (flat, editorial)
- NO rainbow colors (2-3 color max, semantic use)
- Clear visual hierarchy through size and spacing
- Labels read left-to-right, top-to-bottom

## Report/Table Types (from visual-explainer)

For data-dense reports:
- **Section headers** are typographic (not boxed)
- **Numbers** use tabular-nums
- **Comparisons** via columns, not charts (when possible)
- **Structural dividers** via whitespace, not rules
- **Emphasis** via weight/color, not boxes/backgrounds

## Technical Scaffolding

- For fixed-size content (slides, videos at 1920×1080): use padding, not absolute positioning
- Use `text-wrap: pretty`
- Use CSS Grid for layout
- Use `oklch()` for harmonious color math
- Use `container queries` for responsive variants

## Verification Before Delivery

Before claiming "done":
1. Open the HTML in a real browser — check console for 404s, JS errors, React mount failures
2. Test scaling on small viewport — controls must stay reachable
3. Click through primary flow on interactive prototypes

## When to reference the full skill

For deeper details, read:
- `.claude/skills/claude-design/SKILL.md` — full skill contents
- `.claude/skills/claude-design/references/design-principles.md` — detailed principles
- `.claude/skills/claude-design/references/output-formats.md` — format templates
- `.claude/skills/diagram-design/` — diagram-specific patterns
- `.claude/skills/visual-explainer/` — report-specific patterns

These files are available in the project. Read them when working on HTML generation.
