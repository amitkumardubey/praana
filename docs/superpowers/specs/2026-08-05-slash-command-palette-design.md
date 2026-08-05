# Slash command palette — redesign

Status: APPROVED (2026-08-05, design review in session)
Supersedes: inline slash `<select>` popup in `src/ui/tui/prompt/index.tsx`

## Goal

Replace the inline slash-command autocomplete popup with a centered, on-theme command palette. Three drivers (all confirmed by user):

1. **Visual** — current popup is off-palette (hardcoded `#1a1a1a`/`#334455` vs the locked steel/coral theme in `design-proto/LAUNCH-LOCK.md`).
2. **Information density** — show argument hints, aliases, and category per command.
3. **Form factor** — centered palette overlay (like the `/model` selector), not a popup anchored above the prompt.

Mockups reviewed via visual companion; user picked **layout C: list + detail pane**.

## Decisions (locked with user)

- **Trigger**: palette opens immediately when the prompt buffer becomes exactly `/`. Path completions (`./`, `../`, `~/`, absolute) keep the small inline popup.
- **Smart select**: Enter on a command whose `argumentHint` starts with `<` (required arg: `/recall`, `/shell`, `/why`) closes the palette and seeds the prompt with `/name ` (trailing space). All other commands (no hint, `[optional]`, `on|off`) run immediately through the existing dispatch. **Tab** always inserts into the prompt, never runs.
- **Bare-run safety** (verified against `slash-commands.ts`): enum-hint commands (`/thinking`, `/reasoning`, `/incognito`, `/plan`, `/settings`) print current state + usage when run with no argument — harmless, informative; never destructive.
- **Path handoff**: if the palette query contains a second `/`, the palette closes, the prompt receives `/` + query, and the inline path popup resumes. Absolute-path entry stays unbroken.
- **Accent discipline**: LAUNCH-LOCK reserves coral for pulse + prompt glyph; the palette's selected-row `▌` caret is the one sanctioned extension (overlays need a selection signal).
- **Detail pane content**: name + argument hint, description, aliases, category tag. No fabricated usage examples (metadata has none; inventing 24 is filler).
- **Filtering**: fuzzy, reusing `fuzzyFilter` from `src/model-listing.ts`; matches name and aliases; one row per canonical command (aliases are not separate rows).
- **Responsive**: below 64 terminal columns the detail pane hides (degrades to flat list).

## Architecture

### New files

- `src/ui/tui/overlays/palette.tsx` — Solid component: OverlayFrame, query input, custom-rendered rows (caret + bg; `<select>` cannot do the caret), detail pane, footer hints.
- `src/ui/tui/overlays/palette-items.ts` — pure, unit-testable:
  - `buildPaletteItems(metadata): PaletteItem[]` — one item per canonical command (`{ name, argHint, description, aliases, category }`).
  - `filterPaletteItems(items, query): PaletteItem[]` — fuzzy over name + aliases (bare query = curated metadata order).
  - `commandNeedsArgument(item): boolean` — true iff `argumentHint` starts with `<`.

### Modified files

- `src/ui/tui/overlays/state.ts` — `OverlayKind` gains `"palette"`; add `showPalette()`.
- `src/ui/tui/overlays/host.tsx` — render `PaletteOverlay`; add `"palette"` to the escape-dismiss binding list.
- `src/ui/tui/prompt/index.tsx` — remove slash popup branch; add `onSlashTrigger?: () => void` prop, fired on transition of buffer text to exactly `/` (not on paste of a full command). Path completion popup unchanged except colors.
- `src/ui/tui/prompt/autocomplete.ts` — remove `filterSlash` (moves to palette-items); path filtering untouched.
- `src/ui/tui/app.tsx` — pass `onSlashTrigger` into `Prompt`; pass palette callbacks into `OverlayHost`.
- `src/ui/tui/run.tsx` — extract the slash branch of `handleSubmit` into `runSlashCommand(input)` (shared by typed submit and palette); wire `onSlashTrigger` → `overlay.showPalette()` + prompt blur; palette `onRun` → clear prompt, dismiss, `runSlashCommand`; `onInsert` → dismiss, `prompt.setText`, focus; `onDismiss` → dismiss + clear lone `/` + focus.
- `src/slash-commands.ts` — `SlashCommandMeta` gains `category` (see below).
- Path popup colors in `prompt/index.tsx` move from hardcoded hex to theme tokens.

### Categories

| Category | Commands |
|---|---|
| Session | `/exit /new /clear /sessions` |
| Memory | `/recall /digest /memory /incognito` |
| Model & Config | `/model /reasoning /thinking /settings /setup /login /logout` |
| Tools | `/shell /plan /debug` |
| Insight | `/state /stats /scorecard /events /why /help` |

Shown only in the detail pane; the list stays name-only.

## Interaction flow

1. Buffer becomes exactly `/` → prompt fires `onSlashTrigger`, blurs; palette opens with empty query, all 24 commands in curated order.
2. Typing filters (fuzzy, name + aliases). ↑/↓ move selection; scroll window follows.
3. Enter → smart select (run vs insert per `<`-rule). Tab → insert always.
4. Esc / Ctrl+C → dismiss, clear the lone `/`, refocus prompt. Ctrl+C at overlay level never aborts a turn.
5. Query gains a second `/` → handoff to prompt + path popup.
6. After insert, normal typing resumes; `tokenAtCaret` only examines the whitespace-delimited token at the caret, so post-space typing never re-triggers slash logic.

## Visual spec

- Frame: `OverlayFrame`, width `min(78, cols − 8)`; height ≤ ~14 rows with scroll.
- List pane ~22 cols, command names in brand `#d8dce4`.
- Detail pane: name (brand) + arg hint (coral `#c4887a`), description (steel `#7a8294`), `aliases: …` (steel), category tag (steel).
- Selected row: coral `▌` caret + bg `#3a3e4b`.
- Footer (steel, dim): `↑↓ navigate · ↵ run/insert · tab insert · esc close`.
- Colors via OpenTUI props / `TUI_STYLE`; no ANSI strings (theme.ts contract).

## Edge cases

- Focus race on close → existing `focus()` double-`requestRender` pattern in `Prompt`.
- Terminal resize while open → memos recompute width / pane visibility.
- Re-trigger after handoff (deleting `/ho` back to `/`) reopens palette with empty query — acceptable, consistent.
- Pasting `/help` verbatim never opens the palette; submits normally.
- `!` shell prefix flow unchanged.
- Prompt text stays exactly `/` while palette is open; any dismiss path clears it.

## Testing

- Unit tests `tests/palette-items.test.ts`: fuzzy + alias matching, canonical dedupe, `<`-rule for `commandNeedsArgument`, category completeness across all `SLASH_COMMAND_METADATA`.
- Update autocomplete tests: slash cases removed; path cases unchanged.
- `bun typecheck && bun test` clean before commit.
- Manual TTY walkthrough: trigger, filter, run no-arg, insert arg-taking, tab-insert, esc, Ctrl+C, path handoff, narrow-terminal fallback.

## Out of scope (YAGNI)

- Group headers in the list (layout B — rejected).
- Recency ranking / Ctrl+K global launcher (approach 3 — rejected).
- Usage examples in detail pane.
- Changes to slash command implementations themselves.
