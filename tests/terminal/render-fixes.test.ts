import { describe, it, expect } from "bun:test";
import {
  Buffer,
  cell,
  diffBuffers,
  createTtyBackend,
  createAlternateTerminal,
  RESET_ANSI,
} from "../../src/terminal/index.js";

describe("cell() codepoint handling", () => {
  it("keeps an astral emoji intact (no surrogate split)", () => {
    expect(cell("🚀").char).toBe("🚀");
  });

  it("preserves an empty string as the wide-char continuation marker", () => {
    expect(cell("").char).toBe("");
  });

  it("stores only the first code point of a multi-char string", () => {
    expect(cell("ab").char).toBe("a");
  });
});

describe("Buffer.setString wide characters", () => {
  it("marks the trailing column of a CJK glyph as an empty continuation", () => {
    const buf = Buffer.fromSize(6, 1);
    buf.setString(0, 0, "中x");
    expect(buf.get(0, 0).char).toBe("中");
    expect(buf.get(1, 0).char).toBe(""); // continuation marker, not a space
    expect(buf.get(2, 0).char).toBe("x"); // advanced two columns past the glyph
  });

  it("treats an emoji as width 2 with a continuation marker", () => {
    const buf = Buffer.fromSize(6, 1);
    buf.setString(0, 0, "🚀");
    expect(buf.get(0, 0).char).toBe("🚀");
    expect(buf.get(1, 0).char).toBe("");
  });
});

describe("diffBuffers full render", () => {
  it("positions every row absolutely and never emits a bare line feed", () => {
    const buf = Buffer.fromSize(4, 2);
    const { output } = diffBuffers(null, buf);
    expect(output).toContain("\x1b[1;1H");
    expect(output).toContain("\x1b[2;1H");
    expect(output).not.toContain("\n");
  });

  it("writes a wide glyph once and skips its continuation cell", () => {
    const buf = Buffer.fromSize(4, 1);
    buf.setString(0, 0, "中");
    const { output } = diffBuffers(null, buf);
    expect((output.match(/中/g) ?? []).length).toBe(1);
  });

  it("resets style before a cell that clears prior attributes (no bleed)", () => {
    const buf = Buffer.fromSize(3, 1);
    buf.setString(0, 0, "a", { fg: "#ff0000" });
    buf.setString(1, 0, "b"); // default style — must not inherit red
    const { output } = diffBuffers(null, buf);
    const between = output.slice(output.indexOf("a"), output.indexOf("b"));
    expect(between).toContain(RESET_ANSI);
  });
});

describe("diffBuffers incremental", () => {
  it("emits empty output when nothing changed", () => {
    const a = Buffer.fromSize(5, 2);
    a.setString(0, 0, "hi");
    const b = a.clone();
    const result = diffBuffers(a, b);
    expect(result.changedCells).toBe(0);
    expect(result.output).toBe("");
  });

  it("does not overwrite a wide glyph's right half on change", () => {
    const a = Buffer.fromSize(4, 1);
    a.setString(0, 0, "ab");
    const b = Buffer.fromSize(4, 1);
    b.setString(0, 0, "中"); // replaces 'a','b' with a wide glyph + continuation
    const { output } = diffBuffers(a, b);
    // The glyph is written once; the continuation column is not re-written
    // (which would chop the glyph). 'b' (col 1) is covered by the glyph.
    expect((output.match(/中/g) ?? []).length).toBe(1);
  });
});

describe("tty backend resize", () => {
  it("updates dimensions and forces a full redraw on the next frame", () => {
    const writes: string[] = [];
    const backend = createTtyBackend({ write: (s) => writes.push(s), width: 10, height: 4 });

    backend.draw(Buffer.fromSize(10, 4));
    const afterFirst = writes.length;
    backend.draw(Buffer.fromSize(10, 4)); // identical → no write
    expect(writes.length).toBe(afterFirst);

    backend.resize!(20, 6);
    expect(backend.width).toBe(20);
    expect(backend.height).toBe(6);

    backend.draw(Buffer.fromSize(20, 6)); // baseline reset → writes again
    expect(writes.length).toBeGreaterThan(afterFirst);
  });
});

describe("alternate terminal", () => {
  it("exposes width/height as live getters tracking the backend", () => {
    const term = createAlternateTerminal({ write: () => {}, width: 8, height: 3 });
    expect(term.width).toBe(8);
    expect(term.height).toBe(3);
    term.backend.resize!(40, 5);
    expect(term.width).toBe(40);
    expect(term.height).toBe(5);
  });

  it("invalidate() forces a full redraw (the lastBuffer assignment is not a no-op)", () => {
    const writes: string[] = [];
    const term = createAlternateTerminal({ write: (s) => writes.push(s), width: 8, height: 3 });
    const buf = Buffer.fromSize(8, 3);

    term.backend.draw(buf);
    const baseline = writes.length;
    term.backend.draw(buf.clone()); // unchanged → silent
    expect(writes.length).toBe(baseline);

    term.invalidate();
    term.backend.draw(buf.clone()); // forced redraw despite identical content
    expect(writes.length).toBeGreaterThan(baseline);
  });
});
