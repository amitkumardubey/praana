# PRAANA launch screen — design lock

Status: **LOCKED** (2026-08-04)  
Prototype: `design-proto/idle-screen.html`  
Target: OpenTUI Solid TUI (`src/ui/tui/`)

## Composition (top → bottom)

1. **Canvas / launch mark**
2. **Prompt** (inset)
3. **Identity bar** (single row)
4. **Glance bar** (split row)

## Launch canvas

| Element | Spec |
|---|---|
| Wordmark | OpenTUI `ASCIIFont` · `font="tiny"` · text `praana` (lowercase source → font uppercases glyphs) · centered |
| Version | Own line under wordmark · muted · e.g. `v0.12.0` |
| Pulse | Centered breath under version: `  -  ` → ` --- ` → `-----` → shrink back · timer ~480ms · **coral** accent |
| Skills | Own line under pulse · muted · e.g. `104 skills discovered` |
| Not shown | Tagline, model, recalled/db counts, engine on launch |

## Brand / color

| Token | Value | Use |
|---|---|---|
| Base | Steel (cool grey canvas) | Atmosphere, chrome |
| Accent | Coral `#c4887a` | Pulse + prompt `❯` only |
| On flags | Green `#7aaf8a` | `engine on`, `mem on` |
| Identity / most glance | Muted `#7a8294` | Ambient chrome |
| Wordmark | Brand light `#d8dce4` | ASCII mark |

True-color hex via OpenTUI `fg`/`bg`. Respect `NO_COLOR`.

## Prompt

- Inset / reverse-video strip
- Glyph `❯` in coral
- Gap ~`0.75ch` between glyph and text
- Placeholder: `message praana`
- Top border separator above prompt
- Order matches `app.tsx`: prompt above identity + glance

## Identity bar

- Single row (no split)
- Format: `praana · provider/model · cwd · branch`
- All muted; extra space around `·` separators
- Full path kept (no aggressive shorten)

## Glance bar

- **Split**: metrics left · flags right
- Left (muted): `ctx …` · `wm …` · `skills N` · `think medium`  
  - `think` + effort combined → `think <effort>`
- Right (green): `engine on` · `mem on`
- `wm` stays muted (not accent)
- Ctx pressure colors may still escalate when high (existing TUI behavior)

## OpenTUI mapping (implementation notes)

| Prototype | Likely code |
|---|---|
| Tiny wordmark | `<ascii-font text="praana" font="tiny" />` or `ASCIIFontRenderable` |
| Pulse | Small live text + interval / `requestLive`, same pattern as `SpinnerHost` |
| Version / skills | Transcript welcome / boot block — replace dense `formatTuiWelcomeLine` dump |
| Prompt inset | `Prompt` box bg + coral `❯` + padding after glyph |
| Identity | `formatTuiIdentityLine` — slash model, muted, spaced seps, drop heavy hierarchy |
| Glance | `formatTuiGlanceLine` — combine think+effort; add engine flag; split row layout; green ons |

## Explicitly deferred

- Image / GIF wordmark
- Scaling `tiny` beyond cell size
- Identity bar split
- Tagline under mark
