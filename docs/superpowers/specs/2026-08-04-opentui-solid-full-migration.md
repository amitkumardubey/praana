# Full Solid TUI migration — phase-wise plan

**Date:** 2026-08-04  
**Branch:** `feat/ad/opentui-solid`  
**Status:** Active  
**Related:** [OpenTUI migration design](./2026-08-03-opentui-migration-design.md)

## Summary

Finish migrating PRAANA’s interactive TUI from the current **hybrid** (Solid `App`/`Prompt` + imperative hosts for transcript/chrome/wizards) to a **fully Solid** shell on `@opentui/solid`, keeping OpenTUI’s Zig renderer and the `TurnUiSink` / session / turn contracts unchanged.

## Current state (done)

| Area | Status |
|------|--------|
| `solid-js` + `@opentui/solid`, bun preload, `jsxImportSource` | Done |
| Solid [`app.tsx`](../../src/ui/tui/app.tsx) shell | Done |
| Solid [`prompt/`](../../src/ui/tui/prompt/) — grow, history, paste collapse, autocomplete | Done |
| Solid chrome / toast / spinner via [`shell-ui.ts`](../../src/ui/tui/shell-ui.ts) | Done (Phase 1) |
| [`run.tsx`](../../src/ui/tui/run.tsx) bridge | Hybrid — still `new`s transcript + overlays |

**Still imperative:** transcript + sink, model selector, login/logout, slash overlay, setup wizard, download consent, oauth-login UI; legacy `identity-bar.ts` / `glance-bar.ts` / `toast-region.ts` / `spinner.ts` / `inverted-editor.ts` unused by live path but present.

**Invariant:** no changes to `turn.ts` / `session.ts` / `TurnUiSink` method contracts. Pure helpers (formatters, projection, theme) may stay plain TS.

```mermaid
flowchart LR
  subgraph done [Done]
    Toolchain
    AppShell
    Prompt
    P1[Phase1 Chrome Toast Spinner]
  end
  subgraph next [Remaining]
    P2[Phase2 Transcript Sink]
    P3[Phase3 Overlays Wizards]
    P4[Phase4 Standalone TUIs]
    P5[Phase5 Cleanup Tests Docs]
  end
  Toolchain --> AppShell --> Prompt --> P1 --> P2 --> P3 --> P4 --> P5
```

---

## Phase 0 — Baseline (complete)

Solid toolchain, Prompt module, hybrid `run.tsx`.

**Exit:** `bun typecheck` clean; Prompt smoke via interminai.

---

## Phase 1 — Chrome, toast, spinner (complete)

**Goal:** Remove imperative chrome/toast/spinner construction from `run.tsx` `onReady`.

| Target | Solid path |
|--------|--------|
| Identity / glance | `chrome/bars.tsx` + `shell-ui` chrome API |
| Formatters (keep pure) | `chrome/glance-format.ts` |
| Toasts | `toast-host.tsx` + `ui.toast` |
| Spinner | `spinner-host.tsx` + `ui.spinner` |

**Done**

1. Solid `IdentityBar` / `GlanceBar` driven by `createShellUi()` signals.
2. `ToastHost` + `SpinnerHost` in `App`.
3. Bridge: `ui.chrome.setStatus` / `ui.toast` / `ui.spinner` — no imperative class construction in `run.tsx`.

**Exit**

- No IdentityBar/GlanceBar/ToastRegion/Spinner class construction in `run.tsx`.
- Interminai: chrome updates after `/stats`; toast on slash feedback; spinner during a turn.

**Commit:** `feat(tui): solid chrome toast spinner`

---

## Phase 2 — Transcript + sink (largest)

**Goal:** Transcript is a Solid tree; sink mutates Solid stores, not `BoxRenderable.add`.

| Target | Today |
|--------|--------|
| Scroll container | `transcript/container.ts` |
| Entry UIs | `transcript/components/*.ts` |
| Sink | `sink.ts` → new `SolidSink` |
| Keep pure TS | `projection.ts`, `model.ts`, events/gap/opts |

**Work**

1. Solid store: ordered entries + streaming buffers (assistant/thinking).
2. Components: user, assistant (`markdown`), tool row, thinking, system, recall, turn footer.
3. `scrollbox` sticky-bottom; F9 focus via keyboard/traits.
4. `SolidSink` implements `TurnUiSink` (same methods as `OpenTuiSink`).
5. Resume: load bootstrap index into store.
6. `testRender` coverage for a few entry types.

**Exit**

- Full chat turn (user, stream, tools, footer) looks correct.
- Resume restores transcript.
- Interminai tool-turn smoke; F9 works.

**PR:** `feat(tui): solid transcript and sink` (allow split PR if oversized)

---

## Phase 3 — In-session overlays and wizards

**Goal:** Model selector, login/logout, slash-result are Solid + `Portal`; Prompt focus restores cleanly.

| Target | Today |
|--------|--------|
| Model selector | `model-selector.ts` |
| Login / logout | `login-wizard.ts`, `logout-wizard.ts` |
| Slash result / overlay helper | `slash-command-overlay.ts`, `overlay.ts` |

**Work**

1. App overlay signal: `none | model | login | logout | slashResult`.
2. One Solid component per overlay; Esc/cancel → clear signal + `prompt.focus()`.
3. Delete imperative `overlaySlot` / `clearSlot` from `run.tsx`.
4. Fix z-order so overlays don’t paint through chrome.

**Exit**

- `/model`, `/login`, `/logout`, `/help` open/close; Prompt accepts keys after.
- Interminai scripted smoke each path.

**PR:** `feat(tui): solid overlays and wizards`

---

## Phase 4 — Standalone pre-session TUIs

**Goal:** Setup and consent use `render(() => …)` only.

| Target | Today |
|--------|--------|
| Setup wizard | `setup-wizard.ts` (~900 lines — multi-commit OK) |
| Download consent | `download-consent.ts` |
| OAuth helper | `oauth-login-ui.ts` |

**Work**

1. Step machine as Solid signals (provider → auth → model → confirm).
2. Shared Solid primitives: escapable select, masked input.
3. Same lifecycle: destroy standalone renderer before main `App`.

**Exit**

- `praana setup` + first-run consent work under interminai.
- Non-TTY consent tests still pass.

**PR:** `feat(tui): solid setup and download consent`

---

## Phase 5 — Cleanup, tests, docs

**Goal:** Solid-only interactive TUI; docs/tests match.

**Work**

1. Delete `inverted-editor.ts` and unused imperative wrappers.
2. Thin `run.tsx`: create renderer, `render(() => <App />)`, wire controller only.
3. Rewrite `tests/tui-run.test.ts` with `testRender` (un-skip).
4. Expand Prompt/overlay/transcript `testRender` coverage.
5. Update `AGENTS.md`, `ARCHITECTURE.md`, migration notes: OpenTUI **Solid** is the TUI stack.
6. Full `bun typecheck && bun test` + interminai checklist (boot, chat, tools, `/model`, `/login`, `/help`, `/exit`, setup, consent).

**PR:** `chore(tui): retire imperative tui hosts and harden solid tests`

---

## Suggested PR order

| PR | Phase |
|----|--------|
| A | 1 — chrome / toast / spinner |
| B | 2 — transcript / sink |
| C | 3 — overlays / wizards |
| D | 4 — setup / consent |
| E | 5 — cleanup / tests / docs |

Each PR: typecheck + targeted tests + interminai for that phase’s surfaces.

## Risks

- **Transcript fidelity** in Phase 2 — keep projection pure; prefer visual parity over a rushed big-bang.
- **Focus ownership** — rule: overlay focused XOR Prompt focused.
- **testRender vs mock.module** — prefer real `testRender`; avoid global mocks.
- **Setup wizard size** — split by step components inside Phase 4.

## Out of scope

- OpenCode-level keybind/config/extmarks/image-attachment product surface (can follow later).
- Headless `praana run` rewrite.
- Adaptive Context / Cognitive Memory backend changes.
