# Installed Design Skills

This project uses Claude Code skills for HTML content generation. These are cloned into `.claude/skills/` (gitignored — re-clone on new machines).

## Installed

| Skill | Purpose |
|-------|---------|
| **claude-design** | Main: slide decks, landing pages, prototypes, animations, posters. Supports Tweaks protocol for in-browser editing. |
| **diagram-design** | 13 editorial diagram types (self-contained HTML + SVG). Architecture, flow, relationship diagrams. |
| **visual-explainer** | Data tables, project recaps, architecture overviews, diff reviews. |

## Setup (on a new machine)

```bash
mkdir -p .claude/skills
git clone --depth 1 https://github.com/jiji262/claude-design-skill.git .claude/skills/claude-design
git clone --depth 1 https://github.com/cathrynlavery/diagram-design.git .claude/skills/diagram-design
git clone --depth 1 https://github.com/nicobailon/visual-explainer.git .claude/skills/visual-explainer
```

## Usage

Skills are auto-discovered by Claude Code. To invoke explicitly:

- "Use claude-design to build a slide deck for ..."
- "Use diagram-design to create an architecture diagram"
- "Use visual-explainer for a structured data report"

## Notes

- Skills output HTML artifacts that can be rendered by HyperFrames or Remotion
- The Tweaks protocol allows in-browser editing without returning to agent
- All skills avoid generic AI aesthetics (no gradients/emoji/rounded-card-stripes)
