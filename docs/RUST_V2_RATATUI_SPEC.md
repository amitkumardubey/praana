# PRAANA Rust v2 Ratatui Specification

**Status:** Normative design for Rust v2 Phase 9

**End state:** One standalone Rust executable with an in-process Ratatui UI and no Bun, TypeScript, OpenTUI, Solid, N-API, or `.node` sidecar

**Depends on:** `docs/RUST_V2_PLAN.md`, `docs/RUST_V2_UI_CONTRACT.md`,
`docs/RUST_V2_CONFIG_SPEC.md`, and `docs/RUST_V2_TOOL_RUNTIME_SPEC.md`

## 1. Purpose

This document fixes the final all-Rust terminal UI architecture, retained OpenTUI behavior, virtual transcript contract, dependency choices, state/update/render model, bounds, tests, performance thresholds, cutover plan, and TypeScript deletion gate.

Ratatui work starts only after the Rust headless core and temporary TypeScript IPC bridge are stable. The TUI is a client of core services inside the same process. It does not become a second owner of session, provider, tool, artifact, memory, or history state.

This specification owns presentation behavior only. The UI Contract is the
sole owner of permanent semantic command/result/event DTOs, crossing IDs,
priorities, and coalescing. Ratatui imports those types directly from
`praana-core::ui_contract`; it does not depend on IPC and MUST NOT redefine core
semantics. IPC is only one temporary serializer of the same contract.
The Config specification owns all accepted application config. Schema v1 has no
`[ui]` table: presentation choices named here are fixed bounds, CLI flags, or
typed UI settings, not hidden config aliases.

## 2. Current Comparison Baseline and Required Correction

The non-normative behavioral comparison baseline is the current TypeScript
implementation under:

```text
src/app-controller.ts
src/ui-events.ts
src/ui/tui/
src/ui/tui/prompt/
src/ui/tui/overlays/
src/ui/tui/transcript/
tests/*tui*
tests/*transcript*
docs/superpowers/specs/2026-07-28-virtual-transcript-design.md
```

The current UI already has:

- A Solid/OpenTUI app shell, prompt, transcript, overlays, spinner, toasts, launch canvas, identity bar, and glance bar.
- Multiline editing, auto-grow, history, large-paste chips, path completion, and a slash palette.
- Model, login, logout, setup, consent, slash-result, and palette overlays.
- Streaming assistant/thinking rows, pending/finished tool rows, recall chips, system rows, and turn footers.
- Markdown and syntax-theme hooks.
- Keyboard transcript focus and tool/thinking expansion.
- A lightweight transcript index and lazy tool-result references.

The current implementation is not a normative virtualization design:
`TranscriptStore.loadIndex` flattens every group and `TranscriptView` renders
every entry. Rust MUST implement this specification's virtual transcript rather
than porting retained-all behavior. Valid historical content remains reachable
while mounted rows and heavy bodies remain bounded.

## 3. Locked Decisions

- Use Ratatui with the Crossterm backend.
- Use one reducer-owned `AppState`; widgets do not own authoritative mutable state.
- Core emits typed semantic `UiEventRecord` values through the UI-contract sink. It never calls Ratatui and never writes terminal bytes.
- UI actions become typed `CoreCommand` values. Widgets never call session/tool/provider stores directly.
- The direct in-process boundary uses UI-contract Rust DTOs, not serialized JSONL or IPC DTOs.
- Use an alternate screen and raw mode for the full TUI. Provide a plain line-mode fallback.
- Implement the prompt editor in PRAANA using `ropey`; do not use `tui-textarea`.
- Virtualize transcript by complete outer-turn groups and visual lines.
- Page heavy detail from core-owned history/artifacts. Do not retain full historical tool/thinking bodies in UI state.
- Preserve scroll anchors across prepend, append, eviction, expansion, collapse, resize, and reflow.
- Follow live output only when the viewport was already at the tail.
- No feature may require mouse input or color perception.
- Never render raw ANSI/OSC/control sequences from provider, user, tool, artifact, or log text.

## 4. Dependencies

Use workspace-managed dependencies with these feature choices. Cargo.lock pins exact transitive versions for release builds.

```toml
[dependencies]
ratatui = { version = "0.30.2", default-features = false, features = ["std", "underline-color"] }
ratatui-crossterm = { version = "0.1.2", default-features = false, features = ["crossterm_0_29", "underline-color"] }
crossterm = { version = "0.29.0", features = ["event-stream"] }
tokio = { version = "1", features = ["macros", "rt-multi-thread", "signal", "sync", "time"] }
tokio-util = { version = "0.7", features = ["rt"] }
futures = "0.3"
ropey = "1.6"
unicode-segmentation = "1.12"
unicode-width = "0.2"
textwrap = { version = "0.16", default-features = false, features = ["unicode-width"] }
pulldown-cmark = { version = "0.13", default-features = false, features = ["simd"] }
syntect = { version = "5.2", default-features = false, features = ["default-syntaxes", "default-themes", "parsing", "regex-fancy"] }
fuzzy-matcher = "0.3"
lru = "0.12"

[dev-dependencies]
insta = "1"
proptest = "1"
portable-pty = "0.9"
vt100 = "0.15"
criterion = "0.5"
```

Rules:

- Ratatui 0.30 separates backend implementations into workspace crates. Import
  `CrosstermBackend` from `ratatui_crossterm`; do not enable Ratatui's optional
  `crossterm` facade feature in addition to the direct backend dependency.
- Keep Crossterm as a direct dependency because the main loop uses
  `crossterm::event::EventStream`; `event-stream` also enables `events`. The
  backend's `crossterm_0_29` selector and the direct `crossterm` requirement
  MUST resolve to the same single Crossterm 0.29.0 package in `Cargo.lock`.
  Direct Crossterm event/terminal types and the backend crate's
  `ratatui_crossterm::crossterm` re-export therefore have identical Rust types.
- Do not add another terminal abstraction, async runtime, editor widget, Markdown renderer, or syntax engine.
- Do not enable Crossterm serde/event serialization in production.
- Do not enable Syntect Oniguruma. `regex-fancy` keeps the default binary free of that native dependency.
- `portable-pty`, `vt100`, Insta, and Criterion are test/dev dependencies only.
- Release binaries use rustls through the core provider stack; the TUI adds no TLS/network dependency.
- If the listed major/minor pair is unavailable or has a security advisory at implementation time, update this document in the same design-review change before substituting it. The implementer does not silently choose an alternative library.

Official docs.rs sources accessed 2026-09-01:

- Ratatui 0.30.2 API, crate organization, and features:
  <https://docs.rs/ratatui/0.30.2/ratatui/>,
  <https://docs.rs/crate/ratatui/0.30.2>, and
  <https://docs.rs/crate/ratatui/0.30.2/features>.
- Ratatui Crossterm backend 0.1.2 API, backend type, and features:
  <https://docs.rs/ratatui-crossterm/0.1.2/ratatui_crossterm/>,
  <https://docs.rs/ratatui-crossterm/0.1.2/ratatui_crossterm/struct.CrosstermBackend.html>,
  <https://docs.rs/crate/ratatui-crossterm/0.1.2>, and
  <https://docs.rs/crate/ratatui-crossterm/0.1.2/features>.
- Crossterm 0.29.0 API, features, and async event stream:
  <https://docs.rs/crossterm/0.29.0/crossterm/>,
  <https://docs.rs/crate/crossterm/0.29.0/features>, and
  <https://docs.rs/crossterm/0.29.0/crossterm/event/struct.EventStream.html>.

## 5. Crate and Module Layout

Ratatui belongs in `praana-cli`; the complete semantic boundary and event sink
belong in `praana-core::ui_contract` exactly as specified by the UI Contract.

```text
crates/praana-core/src/ui_contract/
  mod.rs
  event.rs             # UI-contract UiEventRecord
  command.rs           # UI-contract CoreCommand
  result.rs            # UI-contract CoreCommandResult
  sink.rs              # UI-contract sinks and bounded delivery

crates/praana-cli/src/tui/
  mod.rs
  terminal.rs          # enter/restore/panic/suspend terminal
  app.rs               # AppState and main loop
  action.rs            # Action enum
  update.rs            # pure reducer and Effect values
  effects.rs           # core requests, paging, auth, timers
  render.rs            # root layout only
  keymap.rs            # mode/focus-aware bindings
  theme.rs             # semantic styles and capability downgrade
  text.rs              # sanitization, width, wrap helpers
  editor/
    state.rs
    edit.rs
    history.rs
    paste.rs
    completion.rs
    view.rs
  transcript/
    state.rs
    index.rs
    viewport.rs
    anchor.rs
    heights.rs
    detail.rs
    markdown.rs
    syntax.rs
    view.rs
    rows.rs
  overlays/
    mod.rs
    frame.rs
    palette.rs
    model.rs
    slash.rs
    risk.rs
    detail.rs
    setup.rs
    login.rs
    logout.rs
    consent.rs
    diagnostics.rs
  chrome/
    launch.rs
    spinner.rs
    toast.rs
    identity.rs
    glance.rs
  plain/
    mod.rs             # line-mode fallback
```

Components may expose `update`, `render`, and focus/navigation helpers. They MUST NOT spawn tasks directly. Async work is returned as an `Effect` and run by `effects.rs`.

## 6. Core/UI Event Sink Separation

The UI Contract owns the exact `UiEventSink` trait, `UiEventRecord`, priority,
coalescing, queue bounds, critical-delivery deadline, detach behavior, and
`CoreCommand`/`CoreCommandResult` types. This document does not restate those
semantics. Core uses that trait for headless, temporary IPC, tests, and Ratatui:

```text
NullUiSink       explicitly consumes/discards all UI events for headless execution
JsonUiSink       writes headless machine-readable output when requested
IpcUiSink        maps events to temporary JSONL frames
ChannelUiSink    sends typed events to in-process Ratatui
RecordingUiSink  deterministic tests
```

Ratatui applies the UI Contract's receiver-detach rule by entering its persistent
fatal presentation state. It never asks core to alter canonical state in
response to delivery or drawing failure.

The UI sends UI-contract commands through an `mpsc` request channel with
`oneshot` responses:

```rust
pub struct CoreCommandRequest {
    pub request: LocalRequestToken,
    pub command: CoreCommand,
    pub respond_to: tokio::sync::oneshot::Sender<CoreCommandResult>,
}

pub struct LocalRequestToken(pub u64);
```

`LocalRequestToken` is presentation-only and monotonically allocated by the
Ratatui effect runner. It never crosses IPC, enters core, or substitutes for
canonical `OperationId`. The exact command coverage and command/result pairing
are the UI Contract's exhaustive tables.

Widgets send `Action`; the effect runner translates approved actions to commands. Rendering never sends a command.

## 7. Application State

```rust
pub struct AppState {
    pub mode: AppMode,
    pub session: SessionUiState,
    pub editor: EditorState,
    pub transcript: TranscriptState,
    pub overlays: OverlayStack,
    pub chrome: ChromeState,
    pub notifications: NotificationState,
    pub focus: FocusTarget,
    pub terminal: TerminalState,
    pub pending: PendingRequests,
    pub settings: EffectiveSettingsDto,
    pub dirty: bool,
    pub should_exit: bool,
}

pub enum AppMode {
    Starting,
    Setup,
    Ready,
    TurnActive,
    Ending,
    Fatal,
}

pub enum FocusTarget {
    Editor,
    Transcript,
    Overlay,
}
```

### 7.1 Session state

`SessionUiState` contains only display/session references:

- Canonical session ID and the UI-contract 12-character resume selector.
- Cwd display label, project label, provider/model label.
- Effective reasoning, memory/native/search/LSP statuses.
- Turn/attempt IDs and whether cancellation is pending.
- Last observed canonical sequence.
- Non-secret boot and recovery notices.

It does not contain provider clients, credentials, tool implementations, event-log handles, memory stores, artifact databases, or StateGraph internals.

### 7.2 Pending requests

Every async effect has a request ID, kind, started time, cancellation token, and optional owner overlay/entry. Late responses are ignored if their owner generation is gone. Closing an overlay cancels its list/detail/auth request where safe.

### 7.3 Overlay stack

Use a stack, not one mutable enum, because a risk or consent confirmation may temporarily cover a model/detail overlay.

```rust
pub struct OverlayStack {
    pub items: Vec<OverlayState>,
    pub generation: u64,
}
```

Maximum stack depth is 4. The top overlay owns keyboard/mouse input. Background overlays render dimmed but do not update selection from input. Pushing beyond four is an internal error shown in diagnostics.

## 8. Action, Update, Effect, Render Loop

### 8.1 Inputs

```rust
pub enum Action {
    Terminal(TerminalInput),
    CoreEvent(UiEventRecord),
    CommandFinished { request: LocalRequestToken, result: CoreCommandResult },
    Tick { now: std::time::Instant },
    Resize { width: u16, height: u16 },
    Suspend,
    Resume,
    Fatal(String),
}

pub enum Effect {
    Invoke { request: LocalRequestToken, command: CoreCommand },
    CancelLocal { request: LocalRequestToken },
    ScheduleTick { deadline: std::time::Instant },
    RestoreTerminalAndExit { code: i32 },
}

pub struct UpdateResult {
    pub effects: Vec<Effect>,
    pub render: RenderRequest,
}

pub enum RenderRequest {
    None,
    Soon,
    Immediate,
}
```

`update(&mut AppState, Action) -> UpdateResult` is deterministic under a supplied clock/ID source. It performs no terminal I/O, filesystem I/O, network I/O, sleeping, or core mutation.

### 8.2 Main loop

The Tokio main loop selects over:

- Crossterm `EventStream`.
- Core UI-event channel.
- Effect completion channel.
- Animation/timer tick only while needed.
- OS shutdown signal.

Per iteration:

1. Receive at least one input.
2. Drain at most 256 immediately available actions or spend at most 4 ms updating, whichever comes first.
3. Coalesce resize and latest-only core actions before reducing them.
4. Execute returned effects through supervised tasks.
5. Render once if dirty and the frame deadline allows it.
6. Flush the backend.

Frame policy:

- Immediate input feedback may render immediately if 8 ms elapsed since the prior frame.
- Streaming/status animation is capped at 30 frames per second.
- Cursor movement/editing is capped at 60 frames per second.
- Spinner ticks every 80 ms only while active.
- Toast expiry schedules its exact next deadline; there is no permanent polling tick.
- When idle, the loop consumes no periodic CPU.

Core event reading never waits for terminal rendering. A slow render coalesces
render/state updates. Only UI-contract latest-only or appendable records may
coalesce/drop before delivery; critical/accepted state is never discarded and
accepted reconciliation repairs provisional gaps.

### 8.3 Rendering

Root layout from top to bottom:

```text
body: launch canvas or transcript (flex remainder)
toast strip (only when non-empty)
spinner/status activity line (only when active)
editor (1 to bounded rows)
identity bar
spacer
glance bar
overlay stack drawn last
```

The render function borrows `&AppState` and writes Ratatui widgets only. It does not mutate measurements. Widgets return measured facts through deterministic layout helpers during update or through a post-render measurement action when terminal geometry is needed.

Use `Terminal::draw` diffing. Do not clear the screen for normal updates. Full clear is allowed only on terminal enter/resume, color-mode change requiring reset, and fatal recovery.

## 9. Terminal Lifecycle

### 9.1 Entry

For a capable TTY:

1. Install a panic hook that restores terminal state before delegating.
2. Enable raw mode.
3. Enter alternate screen.
4. Enable bracketed paste.
5. Enable focus-change events.
6. Enable mouse capture when settings permit.
7. Hide the hardware cursor until the first editor layout.
8. Draw the first frame.

Every successful step records a restoration guard. A later failure unwinds completed steps in reverse order.

### 9.2 Exit

On normal exit, error, panic, SIGINT, SIGTERM, or parent shutdown:

1. Show cursor.
2. Disable mouse capture.
3. Disable focus-change and bracketed paste modes.
4. Leave alternate screen.
5. Disable raw mode.
6. Print the plain session epilogue after terminal restoration.

Restoration is idempotent. No application error may leave the terminal in raw mode intentionally.

### 9.3 Suspend

On Unix Ctrl+Z:

- If no modal consumes it, restore terminal, raise `SIGTSTP`, then re-enter and fully redraw after `SIGCONT`.
- Active core work continues unless the user separately cancels it.

Windows has no suspend binding.

## 10. Prompt Editor

### 10.1 Data model

```rust
pub struct EditorState {
    pub rope: ropey::Rope,
    pub cursor_grapheme: usize,
    pub preferred_column: Option<usize>,
    pub viewport_line: usize,
    pub history: EditorHistory,
    pub paste_store: LruCache<String, SensitivePaste>,
    pub completion: CompletionState,
    pub generation: u64,
}
```

Cursor movement and deletion operate on grapheme clusters. Byte/char/grapheme conversions use cached line-local indexes invalidated only for edited lines. Display columns use `unicode-width`, including tabs expanded to four-column stops. Invalid control characters are replaced before insertion; LF is retained, CRLF/CR normalize to LF.

Maximum editor input is 256 KiB, matching core turn admission. Attempting to exceed it leaves the buffer unchanged and shows a warning.

### 10.2 Editing behavior

Required:

- Insert, overwrite by selection replacement, backspace, delete.
- Left/right by grapheme; Ctrl+Left/Right and Alt+B/F by word.
- Up/down preserving preferred display column.
- Home/End for visual line; Ctrl+A/E for logical line start/end.
- Ctrl+Home/End for buffer start/end.
- Ctrl+U/K delete to line start/end; Ctrl+W deletes prior word.
- Shift+arrow selection where the terminal reports modifiers.
- Undo/redo with a bounded 1,000-operation or 4 MiB journal.
- Enter submits when no completion owns Enter.
- Shift+Enter inserts LF. Because some terminals do not distinguish it, Alt+Enter and Ctrl+J are mandatory newline fallbacks.
- Escape closes completion first; otherwise it participates in double-Escape turn cancel.
- Up/Down browse prompt history only when completion is closed and the cursor is on the first/last logical row respectively.
- History keeps 100 entries in memory for the process and does not persist secret-marked login fields.

Auto-grow is 1 row through `max(6, floor(terminal_height / 3))`, further clamped so body retains at least 3 rows and chrome remains visible. Internal editor scrolling begins after the clamp.

### 10.3 Paste

Bracketed paste is one action, not simulated keypresses.

- Strip ANSI CSI, OSC, DCS, APC, PM, SOS, C0 except LF/TAB, and DEL.
- Normalize newlines.
- Collapse to a visible chip when trimmed content has at least 3 lines or more than 150 characters.
- Chip text is `[Pasted ~N lines #XXXXXX]` using a six-character lowercase base36 ID.
- Full content remains in `paste_store`, is expanded exactly on submit, and is removed when its chip is deleted or submission completes.
- Paste store is capped at 4 MiB and 32 chips. Exceeding the cap asks before inserting plain truncated text; it never silently loses submitted content.
- Paste content is not logged by UI diagnostics.

### 10.4 Completion

Two completion modes are distinct:

- Typing exactly `/` from a non-slash buffer opens the centered slash palette.
- Path-like token completion appears above the editor near the caret.

Path trigger rules match the current behavior: tokens beginning `./`, `../`,
`~/`, `/`, or containing `/`; a bare `.` also triggers. The effect runner sends
UI-contract `CoreCommand::PathComplete` and consumes its typed page. UI filters
case-insensitive prefix, ASCII-sorts display labels, and shows at most 12.

Each async completion request carries editor generation, token start/end, and caret position. Results are discarded if any differ on return. Tab accepts. Up/Down select. Enter accepts unless the buffer already exactly equals the selected completion, in which case it closes completion and submits. Escape closes.

Completion never grants path access. Tool/runtime validation remains authoritative.

## 11. Slash Palette

The slash palette is centered with a search field, result list, and detail pane.

- One item per canonical command; aliases contribute to search but do not create duplicate rows.
- Empty query preserves core metadata order.
- Non-empty query ranks command-name prefix matches first, then fuzzy subsequence matches over name and aliases.
- Maximum visible rows follows available height; selection remains visible.
- Enter runs no-argument and optional-argument commands.
- Tab or Enter inserts commands with required `<...>` arguments into the editor, including trailing space.
- Commands that hand off to model/login/logout/setup overlays replace the palette atomically.
- Escape/Ctrl+C cancels and restores editor focus.

The command metadata catalog is returned only by UI-contract
`CoreCommand::SlashCatalog`. UI does not duplicate descriptions or decide side
effects.

## 12. Transcript Model

### 12.1 Roles

Ratatui renders every `TranscriptRoleDto` supplied by the UI Contract and
defines no local role enum. Role names, availability, wire values, and semantic
content remain owned exclusively by that contract. This specification only
defines how those rows are laid out, virtualized, navigated, and styled.

Every row has stable entry ID, group ID, optional turn/attempt/canonical event IDs, compact metadata, estimated/measured height by layout key, expansion state, and optional immutable content reference.

### 12.2 Groups

Virtualization unit is a complete outer-turn group. A page never splits a committed group. The active group may grow at the tail. System notices before any user turn use a synthetic boot group and do not merge into the first user turn.

### 12.3 Accepted versus provisional

Assistant streaming rows are keyed by `(attempt_id, block_id)` and marked provisional. On rewind, remove only rows owned by that attempt. On accepted event, reconcile complete accepted content/reference and re-key to durable entry ID if necessary. Tool rows begin only after the accepted assistant tool-call step is durable.

Failed/superseded partial output may be shown briefly as provisional but never remains in normal accepted transcript after rewind.

## 13. Virtual Transcript

### 13.1 State

```rust
pub struct TranscriptState {
    pub groups: std::collections::VecDeque<GroupMeta>,
    pub loaded_before: Option<TranscriptCursor>,
    pub loaded_after: Option<TranscriptCursor>,
    pub has_before: bool,
    pub has_after: bool,
    pub viewport: TranscriptViewport,
    pub heights: HeightIndex,
    pub detail_cache: DetailCache,
    pub selected_entry_id: Option<TranscriptEntryId>,
    pub focus_mode: bool,
    pub unseen_tail_groups: u32,
}

pub struct TranscriptViewport {
    pub top_visual_line: u64,
    pub height: u16,
    pub width: u16,
    pub tail_follow: bool,
    pub anchor: Option<ScrollAnchor>,
}

pub struct ScrollAnchor {
    pub entry_id: TranscriptEntryId,
    pub visual_line_within_entry: u32,
    pub screen_row: u16,
}
```

### 13.2 Paging and bounds

These presentation defaults are fixed Ratatui behavior and are not Config-v1
keys:

```text
history page size:                 20 complete groups
overscan:                           5 complete groups each side
maximum compact cached groups:    200
maximum compact entry metadata: 10,000 entries
detail cache:                       8 MiB and 16 content refs
rendered visual-line overscan:      2 terminal heights each side
```

On resume:

1. Request the tail 20 groups.
2. Estimate heights at current width.
3. Position at tail.
4. Request older pages only when the viewport enters the oldest five loaded groups.

When navigating down after older-page eviction, request later groups through the saved cursor. The same group ID is never inserted twice. Pages with overlap are de-duplicated by ID and checked for immutable metadata consistency.

Evict compact groups farthest from the viewport until both group and metadata limits hold, but never evict:

- A visible or overscan group.
- The active live group.
- A group containing the current selected row.
- The anchor group during a height-changing operation.

Eviction releases expanded detail bodies. It keeps only server cursors and the nearest edge group IDs required to detect continuity.

### 13.3 Height index

`HeightIndex` is a Fenwick tree or equivalent prefix-sum structure over loaded entries/groups. This choice is fixed: use a Fenwick tree with `u64` sums and rebuild only when page insertion/eviction changes index order. Point height updates are `O(log n)`.

Height cache key is:

```text
(entry_id, content_revision, width, theme_layout_revision, expanded_state)
```

Color-only theme changes do not invalidate heights. Width, glyph mode, wrapping policy, accepted-content revision, and expansion do.

Offscreen compact rows use estimates. Before a row becomes visible, measure it exactly and update the Fenwick tree while preserving the current anchor.

### 13.4 Anchor preservation

Before prepend, append in non-tail mode, eviction, expansion, collapse, detail-page arrival, or resize:

1. Identify the first visible entry and visual line within it.
2. Record its current screen row.
3. Apply the mutation and height updates.
4. Resolve the same entry and line through the new prefix sums.
5. Adjust `top_visual_line` so it returns to the recorded screen row.
6. If the entry was removed due to a reset, anchor the nearest following entry, then prior entry, then tail.

Tests allow zero-row movement for a surviving anchor. A one-row tolerance is allowed only when a terminal width change makes the exact grapheme line cease to exist; the same source grapheme must remain visible.

### 13.5 Tail follow

- Tail follow starts enabled.
- Any upward scroll, PageUp, Home, mouse wheel up, scrollbar drag away, or transcript selection movement above the final visible entry disables it.
- Reaching within one visual line of the bottom re-enables it.
- End and Ctrl+End explicitly enable it and jump to tail.
- New rows while disabled do not change `top_visual_line`; increment `unseen_tail_groups` and show a textual `N new` marker.
- Accept/rewind/height changes in the active tail group do not move an older-reading viewport.
- Returning to tail clears the marker.

### 13.6 Rendering complexity

Render only rows intersecting viewport plus two viewport heights of line overscan. Per-frame row selection is `O(log n + visible_rows)` using height-prefix lookup. It MUST NOT scan all loaded or historical entries.

No normal append, patch, page, expansion, or eviction performs a full terminal clear or rebuilds Markdown/syntax for unchanged entries.

## 14. Thinking and Tool Expansion

### 14.1 Compact form

- Thinking summary: collapsed header with line count; current-session setting may default live visible summaries expanded.
- Tool: icon/name, redacted display label, pending/running/final summary, success/error text marker, artifact indicator.
- Error rows include a bounded error preview even when collapsed.
- Shell stdout/stderr never streams raw into the screen before redaction.

### 14.2 Expansion

Enter or Space in transcript focus toggles selected expandable row. Mouse primary click on its disclosure marker does the same.

On expand:

1. Preserve anchor.
2. Mark loading and request immutable content by reference.
3. Load only enough pages to cover the expanded row's visible region plus 200 logical lines.
4. Store pages in the bounded detail cache.
5. Update exact height/prefix sums and restore anchor.

Expanded content remains inline and virtualized. Up/Down normally move transcript selection; when the selected expanded row is taller than the viewport, Alt+Up/Down scroll within its visual lines. Press `v` opens the same content in a full-screen detail overlay with independent search and paging.

Collapse drops body pages not used by another open detail view, retains lightweight expansion preference, remeasures, and restores anchor. Eviction always releases heavy pages. Re-expansion reads from core again when the cache missed.

Missing/corrupt references render an inline `content unavailable: <code>` state and keep the compact row. They never produce a blank success.

### 14.3 Tool-specific presentation

- `read_file`: path/range summary; expanded exact redacted content with line numbers optional.
- `edit_file`/`batch_edit`: compact added/removed counts; expanded unified diff.
- `write_file`/`batch_write`: changed path count and warnings.
- `shell`: exit status, duration, stdout/stderr counts; expanded streams preserve boundary labels.
- `run_tests`: pass/fail/skipped summary and expanded failures/output.
- Search/code/LSP/git: bounded structured summary with JSON/plain detail fallback.
- Unknown future tool: generic canonical JSON renderer. The UI must not crash because a tool name lacks a custom presenter.

## 15. Transcript Navigation and Mouse

Entering transcript focus uses F9. Editor blurs and selected row defaults to the last visible row.

Required keyboard behavior:

| Key | Transcript action |
|---|---|
| `Esc` | Return focus to editor |
| `Up`/`Down` | Select prior/next entry and keep visible |
| `PageUp`/`PageDown` | Scroll one viewport minus one row |
| `Home` | Go to oldest loaded; page older until session start on repeat/Ctrl+Home |
| `End` or `Ctrl+End` | Go to tail and enable follow |
| `Enter`/`Space` | Expand/collapse selected tool/thinking row |
| `v` | Open detail overlay |
| `/` | Open transcript text search overlay |
| `n`/`N` | Next/previous search hit |

Mouse behavior when enabled:

- Wheel scrolls transcript under pointer by three visual lines and updates tail-follow.
- Primary click selects a row.
- Primary click disclosure toggles expansion.
- Scrollbar click/drag moves viewport using loaded height index; reaching an unloaded edge triggers paging.
- Primary click editor focuses and places caret at nearest grapheme.
- Primary click overlay item selects; double click or release on explicit action commits.
- Mouse actions never become the only way to invoke a feature.

Disable mouse capture with `--no-mouse`, the typed UI mouse setting,
`TERM=dumb`, or plain mode.

## 16. Markdown and Syntax

### 16.1 Markdown subset

Use Pulldown Cmark and support:

- Paragraphs and soft/hard line breaks.
- ATX headings.
- Bulleted and numbered lists.
- Block quotes.
- Emphasis, strong, strikethrough, and inline code.
- Fenced/indented code blocks with language hint.
- Links rendered as label plus URL when they differ.
- Tables with width-aware fallback to plain rows.
- Horizontal rules.

Images render alt text and URL only. Raw HTML is rendered as escaped plain text. Embedded terminal controls are sanitized before Markdown parsing.

### 16.2 Streaming

For provisional assistant text, reparse only the changed final block/paragraph when possible. If incremental boundaries are ambiguous, reparse that one visible entry, never the transcript. Cache finalized parsed spans by `(content_sha256, markdown_revision)`.

### 16.3 Syntax highlighting

Use Syntect with pure-Rust regex-fancy. Highlight fenced code when `syntax_highlighting=true` and a syntax is known. Unknown languages use code style without highlighting.

Cache highlighted logical lines by `(content_sha256, language, syntax_theme)`, capped at 8 MiB. Wrapping occurs after highlighting and does not rerun Syntect. Highlight at most 2,000 code lines per block for inline display; beyond that show unhighlighted text with a notice while full detail remains accessible.

Syntax failure falls back to plain code. It never hides content or fails the frame.

## 17. Overlays

All overlays use one shared frame/layout/focus implementation. At widths below 60 or heights below 16 they become full-screen; otherwise they are centered with at least two columns/one row margin.

Required overlays:

### 17.1 Slash result

- Displays command output with scrolling.
- Arms dismissal 100 ms after opening to avoid consuming the opening Enter.
- After arming, any key dismisses except navigation keys when content exceeds viewport; Escape always dismisses.

### 17.2 Slash palette

Behavior is section 11.

### 17.3 Model selector

- Async model loading with spinner, error/retry, fuzzy search, provider grouping, current selection.
- Up/Down/Page keys, Tab/Enter commit, Escape cancel.
- At most 200 loaded rows per page; fetch more near boundary.
- Model switch remains a core command and reports protocol-boundary notices.

### 17.4 Risk confirmation

- Highest-priority modal.
- Shows risk class, tool, redacted detail/arguments, and allow-once/deny choices.
- Default selection is deny.
- Enter commits; `y` selects allow once but still requires Enter unless a future setting explicitly enables one-key approval; `n` denies immediately.
- Escape/Ctrl+C/timeout/disconnect denies.
- Approval is bound to confirmation ID and argument hash.

### 17.5 Setup

- Multi-step provider, credential method, endpoint, model, verification, and completion flow driven by core schema/state.
- Back navigation preserves non-secret field values.
- Secret field uses masked rendering, no history, no clipboard echo, and clears its buffer after command submission.
- Cancel during mandatory first setup exits non-zero after terminal restoration; in-session cancel returns to editor.

### 17.6 Login/logout

- Provider picker, API-key form, and device/browser flow status.
- URLs are displayed and opened only after explicit user action.
- Logout shows affected active provider/model and fallback result before confirmation.
- Credentials never enter transcript/toast/diagnostic snapshots.

### 17.7 Consent

- Purpose, download/operation size, location label, persistence choice, and deny.
- Default is deny.
- Core owns consent ID and allowed choices.

### 17.8 Detail/search/diagnostics

- Full-screen paged content viewer with search, next/previous hit, line/byte position, copy-disabled-by-default status, and close.
- Diagnostic console shows redacted tracing records from an in-memory ring, not raw stderr interception.
- Ring holds 1,000 records or 1 MiB, whichever comes first.
- Backtick toggles diagnostics, preserving the current global binding.

## 18. Setup, Login, Consent, and Secret Input

Secret buffers use a dedicated `SecretEditor`:

- Backed by zeroizing memory where practical.
- Renders one mask cell per grapheme up to available width.
- Does not support history, completion, transcript paste chips, undo persistence, or snapshot text.
- Paste is allowed but never displayed or logged.
- Clears on submit/cancel/drop.

Rust core, not TUI, stores credentials and config. UI command results return only redacted status. Toasts and errors must never include submitted values.

## 19. Chrome, Launch, Spinner, Toasts, and Status

### 19.1 Launch canvas

When transcript is empty, show PRAANA wordmark, version, discovered skill count, active provider/model, and concise start hint. The wordmark has an ASCII form for ASCII/no-color mode. Animation is disabled under reduced-motion/plain mode and stops as soon as transcript content exists.

### 19.2 Identity and glance bars

Preserve current semantic split:

- Identity: application/session/project/model identity.
- Glance metrics: context occupancy, token/cost data when enabled, elapsed status.
- Glance flags: append history/memory/thinking/debug/incognito/native status as
  text, not color alone. `engine` is not an initial runtime value.

At narrow widths, truncate in priority order. Keep model/session identity before cost and low-priority flags. Use Unicode display width, not byte/string length.

### 19.3 Spinner

Spinner messages cover starting, thinking, replying, working, switching model, running command, setup/auth, and shutdown. Only one top-level spinner renders. Nested operations update detail text without multiplying animation timers.

### 19.4 Toasts

Tones are info, success, warning, and error. Default lifetimes remain 3 seconds for info/success and 5 seconds for warning/error. Fatal/action-required notices persist until dismissed. Color is supplemental; prefix text identifies tone in no-color mode.

LLM/provider turn errors belong in transcript/system notices and are not duplicated as toasts. Ephemeral command success may use toast.

## 20. Themes and Terminal Capability Policy

Provide exactly three built-in semantic themes initially:

```text
default
high_contrast
mono
```

`default` preserves the current coral accent, steel-muted chrome, light brand, green enabled flags, yellow warning/tool, red error, and purple memory semantics where the terminal supports color. Background zones are disabled by default and do not query OSC 11.

`high_contrast` avoids dim-only distinctions and uses bold/underline plus ANSI 16 colors. `mono` uses attributes/text markers only.

Capability resolution:

1. `--no-color` or `NO_COLOR` -> mono.
2. `TERM=dumb` -> plain mode unless `--force-tui`; forced TUI uses mono, ASCII, no mouse, no animation.
3. Typed UI setting `tool_icons=ascii` -> ASCII glyph set independent of color
   theme. It is not a Config-v1 key.
4. `COLORTERM=truecolor` or Crossterm capability -> RGB default theme.
5. Otherwise map semantic colors to ANSI 256/16.

Never rely on terminal background queries. Never put raw ANSI in Ratatui spans.

Theme state distinguishes layout revision from paint revision so color-only changes do not invalidate transcript heights.

## 21. Resize and Reflow

Crossterm resize events are coalesced; keep only the latest dimensions in one loop drain.

On resize:

1. Capture transcript anchor by entry/source grapheme.
2. Recompute root layout and editor max height.
3. Increment layout width revision.
4. Invalidate only width-dependent height/wrap caches.
5. Measure visible/overscan rows synchronously within a 4 ms budget.
6. Render estimates for remaining rows and refine on later frames.
7. Restore anchor and clamp overlay/editor selections.
8. Force one complete terminal redraw because terminal dimensions changed.

Minimum full TUI is 40x10. Below it, render a stable `Terminal too small: need 40x10, current WxH` screen, keep draining core events into bounded state, and restore normal view when size recovers. Risk confirmations still show class and default deny; pressing `n`/Escape works.

## 22. Accessibility and Fallback

- Every status has text, not color/icon alone.
- Every mouse action has a keyboard equivalent.
- Focused controls use at least two of color, border, marker, bold, or underline.
- ASCII icon mode covers all semantic glyphs.
- High-contrast theme does not use dim text for required information.
- Respect `NO_COLOR`, `TERM=dumb`, `--no-mouse`, `--no-animation`, and `--plain`.
- Sanitize bidirectional control characters in display by rendering a visible placeholder/name while preserving source content in core.
- Width/wrapping tests cover combining marks, wide CJK, emoji sequences, tabs, RTL text, and invalid controls. Source files for this specification remain ASCII; tests may contain Unicode fixtures.

Plain mode:

- Uses Rust line input/output, not Ratatui alternate screen.
- Supports setup/login/consent/risk through numbered prompts with deny defaults.
- Streams accepted assistant text after acceptance or with explicit provisional labels and rewind notices.
- Prints compact tool rows and artifact retrieval instructions.
- Supports slash commands and session resume.
- Non-TTY input dispatches headless `praana run`; it does not attempt interactive plain mode unless explicitly requested.

## 23. Bounded Memory

UI-owned limits:

```text
terminal input queue:                256 events
compact transcript groups:           200
compact transcript entries:       10,000
detail content cache:             8 MiB / 16 refs
Markdown parsed cache:            8 MiB / 256 entries
syntax highlight cache:           8 MiB / 128 blocks
editor text:                    256 KiB
editor undo:                    1,000 ops / 4 MiB
paste store:                    4 MiB / 32 entries
diagnostic ring:                1 MiB / 1,000 records
toasts:                              20
```

When a cache reaches its bound, evict least-recently-used entries not visible, selected, active, or pending. If no item is evictable, do not load more heavy content and show a bounded-resource notice. Never evict canonical data; core history/artifacts remain authoritative.

The TUI MUST NOT retain duplicate complete assistant/tool strings in projection, Markdown cache, widget state, and detail cache. Use `Arc<str>` for shared immutable compact text and content references for heavy data.

## 24. Keymap

Global bindings:

| Key | Action |
|---|---|
| `Ctrl+C` | Cancel active turn; when idle clear non-empty editor; when idle/empty exit |
| `Esc Esc` within 500 ms | Cancel active turn |
| `F9` | Focus transcript |
| Backtick | Toggle diagnostics overlay |
| `Ctrl+L` | Force redraw, not session clear |
| `Ctrl+Z` | Suspend on Unix |

Overlay bindings take precedence, then completion, transcript/editor focus, then global bindings. `Ctrl+C` in mandatory setup exits; in optional overlays it cancels/denies the overlay. Risk confirmation always intercepts Escape/Ctrl+C as deny before global exit.

Key matching uses code plus modifiers from Crossterm. It does not compare localized key labels. Unsupported terminal distinctions have documented fallbacks, especially newline insertion.

## 25. Testing Architecture

### 25.1 Pure reducer/component tests

- Every `Action` against every `AppMode` and focus/overlay state.
- No render or effect side effects inside reducer.
- Late async result generation rejection.
- Keymap precedence and fallback bindings.
- Editor grapheme movement, selection, undo, history, paste chips, completion races, and size limits.
- Overlay focus trap, stack depth, deny defaults, secret clearing.
- Transcript paging, de-duplication, accepted/provisional reconciliation, rewind, expansion, cache eviction, and tail-follow.
- Fenwick prefix/point updates against a naive model with property tests.
- Anchor preservation under randomized page/height/width operations.
- Markdown/control sanitization and syntax fallback.

### 25.2 Ratatui snapshots

Use `ratatui::backend::TestBackend` and Insta. Snapshots are deterministic plain cell grids plus a separate semantic style grid when style matters.

Mandatory sizes:

```text
40x10
40x12
60x16
80x24
120x40
200x60
```

Mandatory modes:

- Default RGB, ANSI-16, high contrast, mono, ASCII icons.
- Empty launch and resumed transcript.
- Editor one line, multiline max height, history, completion, paste chip.
- Each overlay at normal and minimum/full-screen layout.
- Assistant Markdown and streaming partial Markdown.
- Every transcript role, pending/success/error tool, expanded detail, unavailable detail.
- Reading old history while live output/unseen marker arrives.
- Narrow truncation and terminal-too-small view.

Snapshots MUST replace dynamic IDs/times/costs with deterministic fixtures. Secret values must not appear in snapshots.

### 25.3 PTY tests

Use `portable-pty` to spawn the release-like binary and `vt100` to parse terminal output. Tests use a fake provider/core clock and explicit barrier events exposed only under `cfg(test)`; they do not rely solely on sleep.

Mandatory flows:

1. First setup, credential mask, consent allow/deny, and cancellation.
2. Create session, type/edit multiline text, paste chip, path completion, submit.
3. Pre-visible provider retry, post-visible terminal rewind/interruption, cancellation rewind, and accepted reconciliation.
4. Parallel tools, risk allow/deny, timeout/cancel, result expansion.
5. Focus transcript, page to oldest history and back, preserve anchor during live output.
6. Model selector/search/switch and reasoning setting.
7. Slash palette/run/insert/result, `/clear`, `/new`, `/exit`.
8. Resize across all minimum sizes during stream and overlay.
9. Mouse wheel/click/expand/scrollbar when PTY backend supports mouse encoding.
10. Ctrl+C active cancel, idle clear, idle exit; Unix suspend/resume.
11. Panic/fatal injection restores terminal modes and prints safe error.
12. Resume after core crash with uncertain tool notice and no duplicate accepted row.

PTY assertions inspect final screen, emitted core commands, canonical events, exit code, and terminal mode teardown sequences.

### 25.4 Platform matrix

- Linux x64: snapshots, PTY, reference-class full performance gate, and hosted-CI performance smoke.
- Linux arm64: snapshots, PTY, and hosted-CI performance smoke.
- macOS arm64 and x64: snapshots, PTY, keyboard/paste/resize smoke.
- Windows x64: snapshots, ConPTY flows, Job Object interaction, resize, key modifiers.
- At least one tmux run and one SSH terminal run are manual release checks.
- `TERM=xterm-256color`, `screen-256color`, `tmux-256color`, `dumb`, truecolor, `NO_COLOR`, and redirected stdio.

### 25.5 Dependency and performance checks

- `tui_dependency_surface` compile-tests
  `ratatui::Terminal<ratatui_crossterm::CrosstermBackend<_>>` and the direct
  `crossterm::event::EventStream` with production features only. It also passes
  a direct `crossterm::event::Event` to a function accepting
  `ratatui_crossterm::crossterm::event::Event`, proving crate identity.
- CI stores `cargo tree -p praana-cli -e features` and
  `cargo tree -p praana-cli -d`. It fails unless exactly one Crossterm package,
  version 0.29.0, is selected; `event-stream`, `events`, and bracketed paste are
  enabled; Ratatui's `crossterm` facade is disabled; and Ratatui/Crossterm
  `serde`, `osc52`, or unstable features are absent.
- Deterministic performance-invariant tests assert bounded row selection,
  cache limits, no startup detail reads, exact high-rate input, and fixture
  scaling without relying on wall-clock timing.
- The wall-clock harness emits the versioned baseline/candidate record defined
  in section 26. Reference-class and hosted-CI modes are separate commands so a
  hosted run cannot be mistaken for the deletion gate.

## 26. Performance Harness and Acceptance Thresholds

### 26.1 Fixture

Use a deterministic session with:

```text
complete turn groups:          1,000
compact transcript rows:      at least 4,000
historical thinking/detail:    at least 25 MiB
historical tool results:       at least 50 MiB
visible terminal:              120x40
loaded compact cache:          bounded per section 13
```

All heavy bodies remain in core artifacts/history and are fetched on demand.
The harness replays only UI Contract-owned commands, results, and event records;
benchmark barriers and timestamps are local instrumentation and MUST NOT add a
semantic DTO or event variant.

Warm up 100 operations of each measured kind. Measure at least 1,000
typing/stream/scroll samples and 100 page/expand/resize samples in a locked
release build. Report median, p95, p99, maximum, allocations where available,
process CPU time, and RSS before/after. In-process latency ends only after the
Ratatui draw and backend flush complete; storage time is measured separately
where the table excludes it.

Reference and hosted wall-clock modes render through
`CrosstermBackend<CountingWriterV1>`. `CountingWriterV1` consumes every write,
checks and records byte and flush counts, performs no allocation after setup,
and performs no terminal or filesystem I/O. PTY tests cover real terminal I/O
separately. The fixed writer makes this gate measure reducer, layout, Ratatui
diff, Crossterm encoding, and flush dispatch without host terminal variance.

### 26.2 Reference class and baseline record

The full gate runs in a self-hosted CI environment labeled
`linux-x86_64-perf-v1`, not on an arbitrary developer machine. A qualifying
worker has Linux x86_64, four physical cores from one NUMA node assigned through
an exclusive cpuset with SMT siblings outside that cpuset, at least 8 GiB RAM,
swap disabled, a local non-rotational work volume, the `performance` CPU
governor, turbo disabled, and no other process runnable in the benchmark cpuset.
The benchmark process is pinned to that cpuset. `LC_ALL=C`, `TZ=UTC`, and
`RUST_BACKTRACE=0` are set; network access is disabled after dependencies are
present.

Class membership is machine-verifiable. The accepted baseline record completes
the class definition with exact values for the OS image digest, kernel, CPU
vendor/family/model/stepping and microcode, hypervisor or bare-metal state,
NUMA/cpuset topology, RAM, work-volume device and filesystem, governor/turbo
state, Rust toolchain, target, linker, allocator, Cargo profile, `RUSTFLAGS`,
`Cargo.lock` SHA-256, fixture/schema SHA-256, dependency versions/features,
harness version, `CountingWriterV1`, and sample counts. All those fields except
the measured commit and output digests must match for a normal candidate run.
A versioned CPU and memory calibrator runs five times before the harness. A
worker qualifies only when the fingerprint matches and both calibration medians
are within 10 percent of the accepted record. A mismatch is an infrastructure
failure, never a passing or failing candidate.

The implementation provides three non-interchangeable harness modes:

```text
cargo bench --locked -p praana-cli --bench tui_performance -- --mode record-baseline --output target/tui-perf/baseline-draft.json
cargo bench --locked -p praana-cli --bench tui_performance -- --mode reference-gate --baseline benchmarks/baselines/tui/linux-x86_64-perf-v1.json --output target/tui-perf/candidate.json
cargo bench --locked -p praana-cli --bench tui_performance -- --mode hosted-smoke --output target/tui-perf/hosted-smoke.json
```

`record-baseline` and `reference-gate` refuse a non-qualifying worker.
`hosted-smoke` marks its output non-reference and cannot read or write an
accepted baseline. No mode writes directly to the tracked baseline path.

Create the first baseline as follows:

1. Provision a clean qualifying worker and build the baseline commit with
   `cargo build --workspace --release --locked`.
2. Verify a clean tracked worktree, the fixed fixture seed and digest, and the
   dependency-feature checks in section 25.5.
3. Run five fresh harness processes. Each process performs the required warmup
   and sample counts; retain every raw result, including failed or outlying
   runs. A run may be replaced only for a predeclared infrastructure failure,
   which remains recorded.
4. Use the median of the five run-level p95 values and the median of the five
   run-level p99 values as the baseline latency values. Use the median of the
   five run-level idle-CPU and stabilized-RSS values as their baselines. The
   draft must satisfy every absolute threshold before acceptance.
5. Store all run summaries, raw-result digests, calibrator results, environment
   fields, commit SHA, and aggregate values in
   `benchmarks/baselines/tui/linux-x86_64-perf-v1.json`.
6. Review and commit that record independently of a candidate optimization.
   The harness MUST reject a dirty tree, fixture mismatch, fingerprint mismatch,
   or candidate attempt to rewrite the accepted baseline.

For a candidate, CI validates the fingerprint and calibrator, then runs the same
five-process procedure. Candidate gate values are the same medians of run-level
percentiles and resource values used for the baseline. CI retains the complete
candidate JSON and raw outputs as artifacts even on failure; a single fastest
run is never used as the gate result.

A baseline update is never automatic. A toolchain, dependency, image,
microcode, allocator, fixture, or harness change requires old and new commits to
be measured on the same still-qualifying worker, with both result sets attached
to design review. Accepting the new record requires an explicit specification
review; a slower baseline cannot be used to make an otherwise failing candidate
pass.

### 26.3 Latency thresholds

On `linux-x86_64-perf-v1`:

| Operation | p95 | p99 |
|---|---:|---:|
| Editor key action through completed draw | 25 ms | 50 ms |
| Paste of 100 KiB through chip draw | 40 ms | 75 ms |
| Tail assistant delta apply and draw | 33 ms | 75 ms |
| Tool progress/status coalesced draw | 33 ms | 75 ms |
| Transcript wheel/key scroll frame | 25 ms | 50 ms |
| Prepend/append 20-group page and anchor restore | 75 ms | 125 ms |
| Expand/collapse cached 10,000-line detail | 100 ms | 175 ms |
| First uncached detail page visible | 150 ms | 300 ms excluding storage I/O above 100 ms, which is separately reported |
| Resize 120x40 to 80x24 and anchored redraw | 100 ms | 200 ms |
| Tail page to first interactive frame on resume | 200 ms | 400 ms excluding core session-open time |

The candidate gate value for every percentile MUST satisfy both the absolute
table limit and the baseline-relative limit. The relative limit is the larger
of `baseline * 1.20` or `baseline + 2 ms` for p95, and the larger of
`baseline * 1.20` or `baseline + 5 ms` for p99. Quantiles use a documented
nearest-rank implementation over monotonic-clock durations. These are hard
regression gates, not advisory benchmark output.

No operation may have work proportional to total historical body bytes.
Typing, stream, and scrolling gate values must remain within 20 percent when
the fixture grows from 100 to 10,000 groups, excluding intentional page I/O.

### 26.4 Throughput and resource thresholds

- At 200 synthetic key events per second for 10 seconds, lose zero characters and produce the exact final buffer.
- At 100 assistant delta events per second for 30 seconds, accepted final text is exact; rendered frames may coalesce and remain at or below 30 per second.
- Idle TUI process CPU is below 1 percent averaged over 30 seconds on the reference class with no spinner/toast, where one fully busy logical CPU is 100 percent. It also may not exceed the accepted baseline by more than 0.2 percentage points.
- UI incremental RSS from 100 to 10,000 historical groups is at most 40 MiB after cache stabilization.
- The same incremental RSS may not exceed the accepted baseline by more than 8 MiB.
- Repeatedly expanding 100 distinct 1 MiB details leaves detail cache at or below 8 MiB plus 2 MiB allocator tolerance after two seconds.
- Mounted/rendered transcript rows remain bounded by viewport plus two viewport heights and five complete groups of metadata overscan on each side.
- Startup reads no heavy historical detail body before user expansion.
- A 30-minute stream/scroll/resize soak shows no monotonic growth above 10 MiB after caches reach steady state.

MiB means 1,048,576 bytes. RSS is sampled from the process after the same
fixture phases and stabilization barriers in every run.

### 26.5 Hosted-CI smoke

Hosted Linux x64 and arm64 workers do not qualify as the reference class. Their
smoke run uses one fresh release process, 25 warmups, at least 200 samples for
typing/stream/scroll, and at least 30 samples for page/expand/resize. It hard
fails if:

- Any p95 exceeds twice the corresponding absolute p95 in section 26.3.
- Typing, stream, or scrolling grows by more than 30 percent from 100 to 10,000
  groups.
- Any exactness, frame-cap, cache, mounted-row, startup-read, or 40 MiB RSS
  bound in section 26.4 fails.

Hosted idle CPU, p99, and soak measurements are informational because worker
contention is uncontrolled. They cannot replace the full reference-class gate.
Failure of any applicable hard threshold blocks TypeScript deletion. Threshold
or baseline changes require recorded before/after evidence and an update to
this specification, not a test skip.

## 27. Fault and Safety Tests

- Core UI-event channel saturation and delayed rendering.
- Missing/out-of-order duplicate page and detail responses.
- Malformed Markdown, huge unbroken lines, zero-width graphemes, bidi controls, and terminal escapes.
- Core command timeout/cancel and late response.
- Risk expiry during resize/suspend.
- Terminal write failure, stdin EOF, lost TTY, and panic during draw.
- Artifact removed/corrupt/hash mismatch while expanded.
- Session reset while old page/detail requests are in flight.
- Model switch while an overlay is loading.
- Child process/tool output flood without raw terminal writes.

Terminal restoration is asserted after every fatal injection. A UI rendering failure MUST NOT rewrite or corrupt canonical session events.

## 28. Incremental Cutover Plan

### 28.0 Bounded Phase 9 packet

Create only the `praana-core::ui_contract` consumers and `praana-cli/src/tui/`
modules listed in section 5, plus snapshot/PTY/performance fixtures. First add
`tui_ui_contract_v1`, terminal restoration, reducer, and snapshot tests; the
expected red result is missing TUI modules, never missing semantic DTOs. Execute
Stages 1 through 7 below as separate review checkpoints, turning each named gate
green before the next stage. Final green requires platform snapshot/PTY suites,
the qualifying reference performance gate, standalone archive smoke, fmt,
clippy with warnings denied, and workspace tests. TypeScript deletion is the
last sub-packet and cannot begin while any parity row lacks Rust evidence or an
approved deletion.

### Stage 0: Freeze semantic UI contracts

- Implement the already frozen UI-contract DTOs and priorities without Ratatui-local copies.
- Run the same recording-sink tests for headless, temporary IPC, and future channel sink.
- Capture OpenTUI screenshots/key flows and retained behavior matrix.

**Gate:** Rust core behavior and IPC bridge are stable; no Ratatui widget owns core state.

### Stage 1: Ratatui shell behind a development flag

- Lock the section 4 dependency surface and add `tui_dependency_surface` plus
  the single-Crossterm feature-tree check.
- Implement terminal lifecycle, app loop, reducer/effects, theme, launch, chrome, spinner, toast, and plain fallback.
- Connect `ChannelUiSink` and core command channel.
- No provider/tool changes in this stage.

**Gate:** Enter/exit/panic/resize tests pass on Linux/macOS/Windows; headless behavior is unchanged.

### Stage 2: Editor and command surfaces

- Implement editor, history, paste chips, path completion, slash palette/results, settings, and global keymap.
- Add model selector and diagnostics.

**Gate:** Editor property/snapshot/PTY tests and input performance thresholds pass.

### Stage 3: Virtual transcript

- Implement group paging, Fenwick heights, anchor restoration, tail follow, accepted/provisional attempt handling, tool rows, and turn footer.
- Add lazy paged expansion and full-screen detail.
- Add Markdown/syntax caches.
- Complete the section 26 harness, record the first accepted
  `linux-x86_64-perf-v1` baseline by the section 26.2 procedure, and enable the
  separate hosted-CI smoke command.

**Gate:** Every historical row in the 1,000-group fixture is reachable, bounded-memory assertions pass, and all transcript latency thresholds pass.

### Stage 4: Safety and onboarding overlays

- Implement risk, setup, login, logout, consent, auth flow, and secret editor.
- Ensure deny/cancel defaults and exact command binding.

**Gate:** Credential canaries appear nowhere in state snapshots/logs; risk and setup PTY matrices pass.

### Stage 5: Feature-parity hardening

- Complete mouse, accessibility, no-color/ASCII, plain fallback, suspend/resume, narrow layouts, session new/clear/exit, crash recovery notices, and release packaging.
- Run OpenTUI and Ratatui against identical scripted core fixtures and compare semantic outcomes.

**Gate:** Every item in section 29 is pass or has an approved deletion decision.

### Stage 6: Default and soak

- Make Ratatui the default interactive UI.
- Keep temporary OpenTUI selectable only by an explicit development flag for one stabilization interval.
- Run 100 automated sessions, 50 injected crash/resume sessions, 20 manual interactive sessions, and the full release target matrix.

**Gate:** No severity-1/2 parity, durability, terminal restoration, or performance defect remains.

### Stage 7: Delete TypeScript path

- Delete OpenTUI/Solid/UI adapter code, temporary IPC, TypeScript runtime core, Bun preload/build/install paths, N-API wrapper, and `.node` release sidecar.
- Remove UI package dependencies and TypeScript-only tests only after equivalent Rust coverage is present.
- Update release/install/doctor behavior for one standalone Rust executable.

**Gate:** Section 30 passes from clean release archives on every supported target.

## 29. Feature Parity Inventory

Each row is a release checklist item with a Rust test or explicit manual check ID.

### 29.1 Input

- Multiline grapheme-aware editing and cursor placement.
- Enter submit plus Shift/Alt/Ctrl newline fallbacks.
- Auto-grow and internal editor scroll.
- Prompt history boundary behavior.
- Bracketed paste sanitization and large-paste chips.
- Path completion anchored to caret.
- Slash palette trigger, fuzzy filter, run/insert/handoff behavior.
- Input clear versus active-turn cancel versus exit on Ctrl+C.
- Draft retained through transient core/recovery events.

### 29.2 Transcript

- User, assistant, visible thinking summary, tool, plugin-gated memory, system, and footer rows.
- Streaming coalescence and accepted reconciliation.
- Attempt rewind/supersession.
- Multiple parallel tools keyed by call ID.
- Pending/success/error tool presentation.
- Thinking/tool expand/collapse and full detail.
- Virtualized complete-turn paging in both directions.
- Every valid historical row reachable.
- Tail follow, unseen marker, and no focus stealing.
- Anchor preservation across page, detail, eviction, resize, and live updates.
- Reset/new-session transcript behavior.

### 29.3 Overlays and flows

- Slash result.
- Slash palette.
- Model selector.
- Risk confirmation.
- Setup wizard.
- Login and logout.
- Consent.
- Detail/search viewer.
- Diagnostic console.
- Toast, spinner, launch canvas, identity, and glance status.

### 29.4 Rendering and interaction

- Markdown subset and streaming behavior.
- Syntax highlighting and configured syntax theme.
- Default/high-contrast/mono themes.
- Unicode and ASCII tool glyph modes.
- Color and no-color capability downgrade.
- Resize/minimum-size handling.
- Keyboard-only operation.
- Mouse wheel, select, expand, scrollbar, editor placement, and overlay selection.
- Unix suspend/resume.
- Plain line-mode fallback.
- Terminal restoration on every exit/error/panic.

### 29.5 Session/core integration

- New/create/resume/end/exit.
- Clear/reset boundary.
- Model/reasoning changes and status refresh.
- Thinking/incognito/debug/theme settings.
- Headless remains independent of Ratatui.
- Memory absent/default and enabled status.
- Native/search/LSP/provider boot statuses.
- Risk deny on cancel/exit.
- Tool/process cancellation and uncertain-tool recovery notices.
- Session epilogue and 12-character resume selector after terminal restoration.

## 30. TypeScript Deletion Gate

All conditions are mandatory:

- Rust core phases 1 through 8 pass their independent gates.
- Every feature-parity item in section 29 has automated coverage where deterministic and a recorded manual result where terminal-specific.
- Snapshot, PTY, property, fuzz, performance, fault-injection, security, and release-matrix suites pass.
- The accepted section 26.2 baseline is valid, every full threshold passes on a
  qualifying `linux-x86_64-perf-v1` worker, and section 26.5 smoke thresholds
  pass on Linux CI targets.
- Standalone clean archives run `doctor`, headless, new TUI, setup, login, risk, resume, and version smoke with no Bun or Node installation.
- Linux x64/arm64, macOS arm64/x64, and Windows x64 terminate process trees and restore terminal state correctly.
- A 100-session soak and 50 crash/resume runs have no canonical history divergence, duplicate user message, replayed uncertain tool, terminal corruption, or unbounded UI growth.
- No retained behavior is covered only by a TypeScript test.
- `cargo fmt`, `cargo clippy -D warnings`, and `cargo test --workspace` pass.
- Release packaging contains only the Rust executable and required non-Node assets. No `.node` sidecar is loaded.
- The temporary TypeScript IPC client is not required by any install, development, test, doctor, or release command.

Only then delete:

- `src/ui/tui/` and TypeScript UI/controller glue.
- Temporary `src/ui/ipc/` and Rust `--ipc-stdio` handlers unless separately approved as a public API.
- OpenTUI, Solid, keymap, and JSX dependencies/preloads/plugins.
- Bun entry/build paths and TypeScript runtime dependencies.
- `crates/praana-natives` N-API wrapper and release sidecar packaging.
- TypeScript tests whose preserved assertions now exist in Rust.

Do not leave a hidden legacy TUI fallback. After deletion, interactive PRAANA is Ratatui or explicit plain mode, and non-interactive PRAANA is the Rust headless runner.
