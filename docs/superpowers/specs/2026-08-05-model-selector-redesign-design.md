# Design: Model selector redesign (matches slash palette)

**Date:** 2026-08-05
**Status:** Approved
**Branch:** `feat/ad/opentui-solid`

## Summary

Rewrite the `/model` bare selector as a palette-styled, keyboard-navigable picker.
This fixes a real bug (only the first item is selectable) and unifies the picker
visual language with the slash command palette shipped earlier today.

## Problem (root cause)

The current `ModelSelectorOverlay` renders OpenTUI's built-in `<select>` widget with
`focused={false}` while the search `<input>` owns focus. `SelectRenderable` only
advances its internal selection via `handleKeyPress`, which runs only when the select
itself is focused. No keyboard handler ever advances the parent's `selectedIndex`
signal, so the highlight is frozen at its initial value and Enter always commits
`filtered()[selectedIndex()]` — the same first item.

The fix and the redesign are the same change: drop the imperative `<select>` and
render a manual list with the same working pattern the palette uses.

## Design

### 1. Layout & styling (palette-identical)

- Centered `OverlayFrame`, `bg #2a2d37`, `border #3d414d`, width ≈ 56.
- Title line `Select model` (info style) at the top of the frame.
- Focused search `<input>` — placeholder `search models…`; fuzzy filter reused from
  `model-listing.ts` over `provider/modelId/label`.
- List column (manual `For` of `box` rows):
  - Left gutter: coral `▌` caret on the selected row, space otherwise.
  - Model id in `brand`; provider + context window in muted.
  - Selected row `bg #3a3e4b`.
  - Unavailable entries rendered `dim`.
- Detail pane (right, `paddingLeft 2`), shown when terminal width ≥ 64:
  - Model id (brand) + provider (accent).
  - Context window line.
  - Current / availability line: `current model ✓` (`onFlag`), or the
    `disabledReason` (warning) when unavailable.
- Footer: `↑↓ navigate · ↵ select · esc close · N shown` (muted).

### 2. Data & ordering

- `selectedIndex` is a parent-owned signal.
- Current model pinned to top with `✓` (sort: current first, then provider, then id).
- Scrolling window `MAX_VISIBLE = 10`; selected row kept in view (palette `scrollStart`
  math).
- Reuse the exported `formatCtx` from `model-listing.ts` (drop the local variant).

### 3. Keyboard & behavior (the bug fix)

`useBindings` with `target: () => input, targetMode: "focus"` — the palette's proven
pattern:

- `up` / `down` → move `selectedIndex`, skipping unavailable rows.
- `tab` → commit the highlighted selection.
- `enter` (`input` `onSubmit`) → commit the highlighted selection.
- `escape` → `onCancel` (already wired via host `useBindings`).

Commit calls `props.onSelect(provider, modelId)`. `handleModelSelect` in `run.tsx`
(spinner + `/model provider id` + toast) is unchanged.

### 4. Files & testing

- Rewrite `src/ui/tui/overlays/model-selector.tsx`.
- Extract pure helpers (order/current-pin, scroll window, navigation reducer that
  skips unavailable rows) for unit tests, mirroring `palette-items.ts`.
- New `tests/model-selector.test.ts` for those helpers.
- This spec committed to `docs/superpowers/specs/2026-08-05-model-selector-redesign-design.md`.
- Gate: `bun typecheck` + `bun test`, then interactive interminai verification
  (arrows move highlight, Enter commits the highlighted row — not just the first,
  Esc closes, filter works, current pinned with ✓).
