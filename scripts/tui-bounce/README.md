# Terminal-free markdown frame checks

Run the original scroll matrix:

```sh
bun --preload ./tests/helpers/solid-client.ts scripts/tui-bounce/run.ts
```

Race actual provider-sized deltas against the renderer and tree-sitter worker:

```sh
bun --preload ./tests/helpers/solid-client.ts scripts/tui-bounce/run.ts \
  --width 110 --height 40 --batch 0 --deltas chunks --arrival 8 \
  --realtime --fixture atomic-habits
```

Repeat at 80x24 with `--batch 33` for the real sink's leading-edge timer.
`--realtime` does **not** drain highlights after each delta. It uses the sink's
normal scheduler and wall-clock arrivals; its frame listener captures every
presented native frame, including those between arrivals. The original matrix
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
unbatched, and **32 / 55** at 80x24, 33ms batching (8ms arrivals, 8-char slices).
Both runs had zero scroll reversals. Timing changes exact counts, not the cause.
The first raw frame logged `streaming: true`, `drawUnstyledText: true`, and
`isHighlighting: true`, with `painted: "# Atomic"`. The original synchronous
scroll matrix also exposes raw frames; its old assertions only measured height
and direction, not syntax visibility.
