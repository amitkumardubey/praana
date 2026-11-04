# Terminal-free markdown frame checks

Run the original scroll matrix:

```sh
bun --preload ./tests/helpers/solid-client.ts scripts/tui-bounce/run.ts
```

Race actual provider-sized deltas against the renderer and tree-sitter worker:

```sh
bun --preload ./tests/helpers/solid-client.ts scripts/tui-bounce/run.ts \
  --width 110 --height 40 --deltas chunks --arrival 8 \
  --realtime --fixture atomic-habits
```

Repeat with `--width 80 --height 24` for the smaller viewport.
`--realtime` does **not** drain highlights after each delta. It uses wall-clock
arrivals; its frame listener captures every presented native frame, including
those between arrivals. The original matrix
also captures each forced render pass, including intermediate preview frames.

`raw-syntax frames` counts captured frames with visible heading markers, `**`
(including lone markers), backticks, table separator rules, or plain list
markers. Detection uses painted spans, never the unrendered source. OpenTUI
0.8 styles a literal `-` rather than substituting a bullet glyph, so a DIM list
marker is not counted. Ordered list numbers are supposed to remain visible.
The detector is fixture-scoped: these fixtures have no intentional literal
markdown examples in prose or code. Do not use it as a general markdown linter.

## Upstream 0.8.0 raw paint path

`tests/tui-markdown-raw-path.test.ts` is an upstream control, deliberately using
`MarkdownRenderable` directly, not PRAANA's wrapper. It delays completion of a
**real** worker highlight with an `onHighlight` barrier. The first actual frame
contains `## Build systems`; after releasing the barrier it does not. Appending
a second bullet immediately restores `##` to the **same** CodeRenderable's
buffer while `streaming` stays true. Neither unmounting nor finalization is
necessary.

Exact locations in the installed Bun distribution (pinned in package.json):

1. `node_modules/@opentui/core/index.bun.js:12340`, `buildRenderableTokens`,
   coalesces ordinary blocks. `createMarkdownBlockToken` at **12322** creates a
   synthetic paragraph with `text: raw` and `tokens: []`.
2. `createInitialStyledText` at **11763** falls back to **inline** lexing of
   that raw paragraph. Inline parsing conceals balanced bold but cannot remove
   block heading/list markers. It also preserves unfinished emphasis literally.
3. `createMarkdownCodeRenderable` at **11974** enables `drawUnstyledText` when
   that preview exists. `applyMarkdownCodeRenderable` at **12259** installs it
   on subsequent updates (including `updateStreamingPreview` while highlighting).
4. `node_modules/@opentui/core/chunk-bun-6kxdhkdc.js:14748`, `CodeRenderable`
   content setter, writes this preview into the native text buffer immediately.
   `updateStreamingPreview` at **14769** does the same. The existing
   keep-previous-styled-buffer path at **14752** only runs when
   `drawUnstyledText` is false.
5. `ensureVisibleTextBeforeHighlight` at **14919** allows the preview to paint;
   `startHighlight` subsequently awaits tree-sitter and installs concealed
   styled chunks. A normal render can therefore present the preview first.

Baseline production code: `f5bf418`. Adding measurement without changing that
code reproduced **64 raw-syntax frames / 82 captured frames** at 110x40,
with 8ms arrivals and 8-char slices. That run had zero scroll reversals. Timing
changes exact counts, not the cause.
The first raw frame logged `streaming: true`, `drawUnstyledText: true`, and
`isHighlighting: true`, with `painted: "# Atomic"`. The original synchronous
scroll matrix also exposes raw frames; its old assertions only measured height
and direction, not syntax visibility.

A second raw path exists at `index.bun.js:12482` (`buildTableContentCache`):
when the parsed table has no data rows, it returns no table cache and
`createTableBlock` (**12619**) falls back to a markdown CodeRenderable. The
header and separator can therefore remain literal even after highlighting.

## Wrapper and regression checks

`src/ui/tui/transcript/retained-markdown.ts` retains the last fully transformed
`StyledText` per markdown CodeRenderable. It uses public `onChunks`,
`drawUnstyledText` and `updateStreamingPreview` APIs. After an upstream content
update it restores that snapshot synchronously, before presentation; a new block
starts empty until its first highlight is ready. Parsing and in-place block
reconciliation remain upstream's. Theme/capability refreshes retain this behavior
and preserve hyperlink concealment. No worker throttling or dependency patches
are involved.

The TUI opts into additional `stabilizeStreamingMarkdown` rules: unfinished
emphasis/backtick spans, lone syntax lines, and incomplete pipe-led table rows.
Table candidates wait for both the separator and first complete data row.
Fenced code is exempt, and the original source is used unchanged at completion.
The store now marks the first assistant delta live even when the sink must append
a new entry on that delta. Scroll-only stabilizer callers keep their old behavior.

Tests:

- `tests/tui-scroll-bounce.test.ts`: all four forced-pass viewport/delta scenarios
  and both real-timer Atomic Habits scenarios require zero raw-syntax frames;
  bounce and scroll-reversal assertions remain zero.
- `tests/tui-retained-markdown.test.ts`: a controlled slow **real** highlight
  holds the exact previous styled frame, then publishes new text. At 80 and
  110 columns, whole-answer character and styled-span captures after streaming
  are byte-identical to the unwrapped upstream renderer. Intentionally unfinished
  final syntax is restored too. Late hyperlink capabilities also match upstream.
- `tests/streaming-markdown.test.ts`: original expectations remain unchanged;
  additional opt-in tests cover incomplete spans, escapes, intraword underscores,
  nesting, lone markers, fences and table construction.

Removal checks (working-file edits, restored immediately; no history rewriting):

1. Change only `<retained_markdown>` back to `<markdown>` in `entries.tsx`,
   keeping the syntax stabilization enabled. Run
   `bun test tests/tui-scroll-bounce.test.ts --test-name-pattern 'never paints raw syntax'`.
   The zero-raw assertion failed with **[49, 24]** raw frames.
2. Restore the wrapper; remove only `{ withholdIncomplete: true }` from its
   stabilizer call. The same test failed with **[9, 14]** raw frames.
3. Restore both changes and rerun the tests/gate. Exact real-timer frame counts
   vary; the required fixed count is always **0**.

For an upstream solution, expose a Markdown option to disable the synchronous
inline preview: omit `initialStyledText` and keep `drawUnstyledText: false`, using
CodeRenderable's existing retain-previous-buffer branch. Keep markdown streaming
parsing enabled. Separately, render a header-only table structurally rather than
falling back to raw source. The app still needs a policy for unfinished inline
syntax that could otherwise legitimately remain literal until completion.

## Verification snapshot

An earlier verification recorded **0/60** raw frames at 110x40 with 8ms
arrivals. Timing changes exact frame counts; the required raw-frame count,
bounce and scroll reversals are all zero.

An earlier isolated-home, provider-key-free `bun typecheck && bun test tests/`
gate passed typechecking and ran **2,843 tests across 236 files**: 2,842 passed, and
the known real native-status probe exceeded its 5s timeout. Rerunning that exact
probe alone under another isolated home passed at the default timeout (4.59s,
1 pass / 0 fail). Earlier full gates passed 2,829 and 2,836 tests without failures.

This is a Linux native-memory renderer verification, not a Windows Terminal
transport/visual verification. The Atomic Habits fixture matches the recorded
structures and representative text; its synthetic delta boundaries/timing are
not a capture of the owner's provider stream. The owner must re-record the real
Windows Terminal session to confirm the visual symptom is gone there.
