# OpenTUI Migration Design

**Date:** 2026-08-03
**Branch:** `feat/ad/opentui-migration`
**Status:** Draft

## Summary

Replace the `@earendil-works/pi-tui` rendering engine with `@opentui/core` (+ `@opentui/keymap`) throughout PRAANA's TUI layer, preserving the existing user-facing interface/behavior wherever possible and allowing incidental visual improvements where OpenTUI's native flexbox layout and scrolling are naturally better.

## Motivation

Primary: **performance and rendering quality**. pi-tui uses a line-based `render(width): string[]` model that requires manual ANSI-aware width math (`visibleWidth`, `wrapTextWithAnsi`, `truncateToWidth`) throughout the codebase. OpenTUI is a native Zig renderer with a real flexbox layout engine, retained component tree, and built-in primitives (`Box`, `Text`, `Input`, `Select`, `ScrollBox`, `Markdown`) that eliminate most of this manual width work. Secondary: maintenance — OpenTUI is actively maintained (12.9k GitHub stars, powers OpenCode and terminal.shop in production), has a larger component surface, and ships prebuilt native binaries per platform.

## Scope & Boundary

### Untouched (no changes)
- `turn.ts` — UI-agnostic; only calls `TurnUiSink` callbacks
- `session.ts` — pure data/lifecycle layer
- `src/ui-events.ts` — `TurnUiSink` contract stays as-is
- `headless-run.ts` — headless sink implementation unaffected

### Rewritten (~29 files, ~6,822 lines)
Everything under `src/ui/tui/`:
- `run.ts` (654 lines) — orchestration, wires chrome/transcript/input/sink
- `transcript/container.ts` (733 lines) — retained transcript component tree
- `transcript/components/*.ts` (7 files) — user/assistant/thinking/tool/recall/system/turn-footer components
- `inverted-editor.ts` (107 lines) — wraps Textarea with prompt overlay
- `sink.ts` (443 lines) — `PiTuiSink` → `TurnUiSink` adapter
- `chrome/identity-bar.ts`, `chrome/glance-bar.ts` — status bars
- `theme.ts` (71 lines) — TUI_STYLE semantic color map
- `model-selector.ts` (296 lines) — `/model` search+select overlay
- `login-wizard.ts` (924 lines) — `/login` multi-step flow
- `logout-wizard.ts` (180 lines) — `/logout` flow
- `setup-wizard.ts` (889 lines) — first-run standalone TUI
- `download-consent.ts` (104 lines) — standalone pre-session consent TUI
- `toast-region.ts`, `slash-command-overlay.ts`, `boot-summary.ts`, `banner.ts`, `tool-icons.ts`, `render-utils.ts`, `markdown-theme.ts` — remaining utilities

### Dropped (net simplification)
- `redirect-pi-logs.ts` and `tests/redirect-pi-logs.test.ts` — pi-tui-specific hack to redirect pi-tui's hardcoded crash-log path (`~/.pi/agent/pi-crash.log`). OpenTUI has no equivalent hardcoded logger, so this is deleted outright.

### Type-only pi-tui references (migrate to OpenTUI's `SelectOption`)
- `src/setup/setup-readline.ts` — imports `SelectItem` type from pi-tui; replace with `@opentui/core`'s `SelectOption` type
- `src/setup/provider-options.ts` — imports `SelectItem` type from pi-tui; replace with `@opentui/core`'s `SelectOption` type
- `src/model-listing.ts` — imports `fuzzyFilter` from pi-tui; port to a small local util (same one used for `SelectRenderable` filtering per Component Mapping)

## Component Mapping

| pi-tui (today) | OpenTUI (target) | Notes |
|---|---|---|
| `TUI` + `ProcessTerminal` | `createCliRenderer()` | Root renderer; replaces manual terminal raw-mode wiring |
| `Container` | `BoxRenderable` (no border) | Flexbox `flexDirection`/`gap` replace manual line-joining |
| `Text` | `TextRenderable` | Direct match |
| `Spacer` | `Box({ height: n })` or flex `margin` | No dedicated Spacer; flexbox gap/margin does this |
| `Input` | `InputRenderable` | Direct match |
| `Editor` (multi-line + autocomplete) | `TextareaRenderable` + custom autocomplete popup | OpenTUI has no built-in slash/file autocomplete; reimplement using `Textarea` + a `Select`/`Box` popup driven by our own filter logic |
| `Loader` (spinner) | Custom `TextRenderable` with `setInterval` cycling spinner glyphs | Small ~20-line component |
| `SelectList` + `fuzzyFilter` | `SelectRenderable` + local fuzzy-filter util (ported from pi-tui or PRAANA's own) | `Select` has no built-in fuzzy search |
| `Markdown` + `MarkdownTheme` | OpenTUI `Markdown` construct/component | Direct match; tree-sitter highlighting (visual diff expected, acceptable) |
| Manual F9 focus-scroll | Native `ScrollBoxRenderable` | Incidental improvement |
| `matchesKey`/`getKeybindings` | `@opentui/keymap` commands + keybindings | Reimplement Ctrl+C, F9, Escape, arrows etc. |
| `mock.module("@earendil-works/pi-tui", ...)` | `@opentui/core/testing` (`createTestRenderer`, `mockInput`, `captureCharFrame`) | Real native renderer in tests |
| Figlet banner (`banner.ts`) | `ASCIIFontRenderable` or keep `figlet` npm dep → `Text` | Verify font parity during implementation |
| overlay (`tui.showOverlay`/`OverlayOptions`) | Absolute-positioned `BoxRenderable` on `renderer.root` | OpenTUI has no single built-in overlay API; `position: absolute` in flexbox is the working assumption |
| `visibleWidth`/`truncateToWidth`/`wrapTextWithAnsi` | Mostly unnecessary — OpenTUI handles ANSI-aware width internally | Remaining custom wrap logic ported to plain string utils if needed |

## Orchestration

`run.ts` keeps the same overall responsibility (build chrome + transcript + input, wire `TurnUiSink`, handle slash commands and overlays) but rewritten against OpenTUI:

- `createCliRenderer()` replaces `new TUI(new ProcessTerminal())`.
- `IdentityBar`/`GlanceBar` become `BoxRenderable` rows pinned top/bottom of `renderer.root` via flexbox `flexDirection: column` with fixed-height header/footer + flexible middle.
- `TranscriptContainer` becomes a `ScrollBoxRenderable` holding one child renderable per transcript entry (7 component types).
- `InvertedEditor` becomes a thin wrapper around `TextareaRenderable` (prompt glyph + inverse styling via OpenTUI style props).
- `PiTuiSink` (`sink.ts`) is rewritten 1:1 against new renderables but keeps implementing `TurnUiSink` unchanged — same method signatures, same call sites in `turn.ts`.

**Standalone pre-session TUIs** (`setup-wizard.ts`, `download-consent.ts`): both currently spin up their own `TUI`/`ProcessTerminal`. They'll spin up their own `createCliRenderer()` instance, called and torn down (`renderer.destroy()`) before the main session renderer starts — same lifecycle shape, different constructor.

## Testing Strategy

- Rewrite all TUI tests against `@opentui/core/testing` (`createTestRenderer`, `mockInput`, `captureCharFrame`/`captureSpans`) — real native renderer, no hand-rolled fakes.
- Delete `tests/redirect-pi-logs.test.ts` (feature removed).
- Keep the same test intent per file (Ctrl+C handling, transcript gap/spacer logic, editor prompt overlay, theme/style helpers) — only the harness changes.
- `bun typecheck && bun test` must pass clean before commit.

## Rollout Steps

1. Create branch `feat/ad/opentui-migration`.
2. `bun remove @earendil-works/pi-tui && bun add @opentui/core @opentui/keymap`.
3. Rewrite in dependency order: theme/style → chrome bars → transcript component family → transcript container → inverted editor/input → sink → wizards/model-selector → `run.ts` orchestration → standalone setup/download-consent renderers — with tests ported alongside each piece.
4. Manual smoke test: full session (boot banner, chat turn, tool calls, thinking blocks, `/model`, `/login`, `/logout`, `/setup` first-run flow, resize behavior).
5. Update `AGENTS.md` — replace pi-tui references in `src/ui/tui/` tree description and Setup/Testing sections with OpenTUI equivalents.
6. `bun typecheck && bun test` clean, commit (conventional commits), open PR.

## Risks & Unknowns

1. **Overlay/z-order mechanism** — exact mechanism for popups (model selector, wizards, slash-command result, download-consent) needs confirming against OpenTUI's Layout/Renderer docs. Working assumption: absolute-positioned `BoxRenderable` managed as a child of `renderer.root` with z-order control. First thing to prototype.
2. **Textarea caret-position API** — need to confirm cursor-position/caret APIs on `TextareaRenderable` are sufficient to reproduce the current slash-command/file-path autocomplete popup anchored under the cursor.
3. **ASCIIFont font parity** — low risk, cheap fallback (keep `figlet` npm dep, render output as `Text`).
4. **Markdown/syntax-highlighting theme parity** — OpenTUI's `Markdown`/`Code` use tree-sitter (different highlighter than current `cli-highlight`); visual diff expected, acceptable per design intent.
5. **Native binary compatibility** — `@opentui/core` ships prebuilt binaries for Linux x64 (both glibc and musl). CI environment compatibility needs verification during first `bun add`.