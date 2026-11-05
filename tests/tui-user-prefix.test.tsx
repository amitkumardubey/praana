/**
 * User turns are distinguishable from assistant prose.
 *
 * Every `role: "user"` transcript entry renders a coral `❯ ` prefix in a fixed
 * two-column box, with the message text in a flexGrow sibling box so wrapped
 * and multi-line text hangs two columns in — the text column stays under the
 * first character after the prefix. The prefix is layout, never part of
 * `entry.text`: the store, the event log and search keep the plain message.
 *
 * Assertions use `captureSpans()` cell widths (Bun.stringWidth), so CJK and
 * emoji (width 2) are measured in real terminal cells, not UTF-16 units.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import type { ScrollBoxRenderable } from "@opentui/core";
import { OpenTuiSink } from "../src/ui/tui/sink.js";
import type { ToastApi } from "../src/ui/tui/shell-ui.js";
import { TranscriptProjection } from "../src/ui/tui/transcript/projection.js";
import { createTranscriptStore, type TranscriptStoreApi } from "../src/ui/tui/transcript/store.js";
import { releaseMarkdownSyntaxStyles } from "../src/ui/tui/transcript/markdown-theme.js";
import { TranscriptView } from "../src/ui/tui/transcript/view.js";
import type { TranscriptRenderOpts } from "../src/ui/tui/transcript/opts.js";
import { TUI_PALETTE } from "../src/ui/tui/theme.js";

const OPTS: TranscriptRenderOpts = {
  markdownRendering: true,
  syntaxTheme: "default",
  backgroundZones: false,
  useUnicode: true,
};

const TOAST: ToastApi = {
  show() {},
  clearErrors() {},
  attachConsole() {},
};

const PREFIX = "\u276f";
/** `scrollbox paddingLeft={2}` in the transcript view. */
const GUTTER = 2;

/** A terminal cell: one display column of the captured frame. */
interface Cell {
  /** Empty string for the trailing cell of a width-2 character. */
  ch: string;
  fg: { r: number; g: number; b: number } | null;
}

interface Harness {
  setup: Awaited<ReturnType<typeof createTestRenderer>>;
  store: TranscriptStoreApi;
  sink: OpenTuiSink;
  scroll: ScrollBoxRenderable;
  /** One row of cells per captured frame line. */
  grid(): Cell[][];
  /** Row and column of the first `❯` in the frame. */
  prefixAt(grid: Cell[][]): { row: number; col: number };
  dispose(): Promise<void>;
}

/** Frame text of a row from `col` on, right-trimmed. */
function textFrom(row: Cell[], col = 0): string {
  return row
    .slice(col)
    .map((cell) => cell.ch)
    .join("")
    .replace(/\s+$/, "");
}

/** Non-empty frame rows from `start`, as `textFrom(row, col)` strings. */
function rowsFrom(grid: Cell[][], start: number, col: number): string[] {
  return grid
    .slice(start)
    .map((row) => textFrom(row, col))
    .filter((text) => text.length > 0);
}

/** Coral #c4887a as the renderer reports it (0-1 floats). */
function isCoral(fg: Cell["fg"]): boolean {
  if (!fg) return false;
  const [r, g, b] = [0xc4, 0x88, 0x7a].map((v) => v / 255);
  return Math.abs(fg.r - r) < 0.02 && Math.abs(fg.g - g) < 0.02 && Math.abs(fg.b - b) < 0.02;
}

function cellsOf(setup: Harness["setup"]): Cell[][] {
  return setup.captureSpans().lines.map((line) => {
    const cells: Cell[] = [];
    for (const span of line.spans) {
      for (const ch of span.text) {
        const width = Bun.stringWidth(ch);
        cells.push({ ch, fg: span.fg });
        // A width-2 glyph paints the next cell too; mark it as a continuation.
        for (let i = 1; i < width; i++) cells.push({ ch: "", fg: span.fg });
      }
    }
    return cells;
  });
}

/** Column of the first non-space cell at or after `from`, or -1. */
function firstTextColumn(row: Cell[], from = 0): number {
  for (let x = from; x < row.length; x++) {
    const ch = row[x]!.ch;
    if (ch !== "" && ch !== " ") return x;
  }
  return -1;
}

const live: Harness[] = [];

async function mountTranscript(width: number, height: number): Promise<Harness> {
  const setup = await createTestRenderer({ width, height, footerHeight: 0 });
  const store = createTranscriptStore();
  const sink = new OpenTuiSink({ ...store.mount }, TOAST, {
    ambient: "quiet",
    showThinking: () => false,
    onSpinnerMessage: () => {},
    ctxWindowTokens: 128_000,
    engineMode: false,
    projection: new TranscriptProjection({ useUnicode: true }),
  });
  const keymap = createDefaultOpenTuiKeymap(setup.renderer);
  await render(
    () => (
      <KeymapProvider keymap={keymap}>
        <box width="100%" height="100%" flexDirection="column">
          <TranscriptView store={store} opts={OPTS} />
        </box>
      </KeymapProvider>
    ),
    setup.renderer,
  );
  const found = setup.renderer.root.findDescendantById("transcript");
  if (!found) throw new Error("transcript scrollbox was not mounted");
  const scroll = found as ScrollBoxRenderable;

  const harness: Harness = {
    setup,
    store,
    sink,
    scroll,
    grid: () => cellsOf(setup),
    prefixAt(grid) {
      for (let row = 0; row < grid.length; row++) {
        const col = grid[row]!.findIndex((cell) => cell.ch === PREFIX);
        if (col >= 0) return { row, col };
      }
      throw new Error(`no ${PREFIX} prefix in frame`);
    },
    async dispose() {
      releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
      store.dispose();
      await setup.dispose();
    },
  };
  live.push(harness);
  await paint(harness);
  return harness;
}

/** Render until the layout settles (a couple of passes is enough here). */
async function paint(h: Harness): Promise<void> {
  for (let i = 0; i < 3; i++) await h.setup.renderOnce();
}

afterEach(async () => {
  while (live.length > 0) await live.pop()!.dispose();
});

describe("user message prefix", () => {
  it("puts a coral ❯ in the entry's first two columns and starts the text after it", async () => {
    const h = await mountTranscript(80, 12);
    h.sink.appendUser("Explain the sky.");
    await paint(h);

    const grid = h.grid();
    const { row, col } = h.prefixAt(grid);
    const cells = grid[row]!;
    expect(col).toBe(GUTTER);
    expect(cells[col]!.ch).toBe(PREFIX);
    expect(cells[col + 1]!.ch).toBe(" ");
    expect(isCoral(cells[col]!.fg)).toBe(true);
    expect(isCoral(cells[col + 1]!.fg)).toBe(true);
    // The message starts exactly two cells after the glyph.
    expect(firstTextColumn(cells, col + 2)).toBe(col + 2);
    expect(textFrom(cells, col)).toBe(`${PREFIX} Explain the sky.`);
  });

  it("keeps the plain message in the store (the prefix is layout only)", async () => {
    const h = await mountTranscript(80, 12);
    const message = "no prefix in the data, please";
    h.sink.appendUser(message);
    await paint(h);

    const entries = h.store.entries.filter((entry) => entry.role === "user");
    expect(entries.map((entry) => entry.text)).toEqual([message]);
    expect(entries.some((entry) => entry.text.includes(PREFIX))).toBe(false);
  });

  it("hangs a long wrapped single line two columns in", async () => {
    const h = await mountTranscript(80, 24);
    const message =
      "This single user line is deliberately long enough that the renderer has " +
      "to wrap it at least twice inside an eighty column viewport, and every " +
      "continuation row must begin under the first character of the message.";
    h.sink.appendUser(message);
    await paint(h);

    const grid = h.grid();
    const { row, col } = h.prefixAt(grid);
    const rows = rowsFrom(grid, row, col);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]).toBe(
      `${PREFIX} This single user line is deliberately long enough that the renderer has to`,
    );
    // 80 columns - 2 gutter each side - 2 prefix = 74 text columns.
    for (const text of rows.slice(1)) expect(text.length).toBeLessThanOrEqual(74);
    // Every continuation row starts under the first character of the message.
    for (const frameRow of grid.slice(row + 1)) {
      if (textFrom(frameRow, col).length === 0) continue;
      expect(firstTextColumn(frameRow)).toBe(col + 2);
    }
    expect(rows.map((text) => text.replace(PREFIX, "").trim()).join(" ").replace(/\s+/g, " ")).toBe(
      message,
    );
  });

  it("hangs multi-line text with blank lines under the first character", async () => {
    const h = await mountTranscript(80, 16);
    h.sink.appendUser("first line\n\nthird line\nfourth line");
    await paint(h);

    const grid = h.grid();
    const { row, col } = h.prefixAt(grid);
    expect(textFrom(grid[row]!, col)).toBe(`${PREFIX} first line`);
    // A blank line is a real row: the next text row is two rows down.
    expect(textFrom(grid[row + 1]!, col)).toBe("");
    expect(textFrom(grid[row + 2]!, col)).toBe("  third line");
    expect(textFrom(grid[row + 3]!, col)).toBe("  fourth line");
    expect(firstTextColumn(grid[row + 2]!)).toBe(col + 2);
    expect(firstTextColumn(grid[row + 3]!)).toBe(col + 2);
  });
});
