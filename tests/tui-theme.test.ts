import { describe, it, expect } from "bun:test";
import {
  TUI_STYLE,
  textAttributesOf,
  truncatePlainText,
  truncateSegments,
  segmentsToPlainText,
  visibleTextWidth,
  zonesEnabled,
  type TextSegment,
} from "../src/ui/tui/theme.js";

describe("TUI_STYLE", () => {
  it("defers normal text to the terminal default (empty style)", () => {
    expect(TUI_STYLE.text).toEqual({});
  });

  it("uses dim for muted/system/faint/border/thinking styles", () => {
    expect(TUI_STYLE.muted.dim).toBe(true);
    expect(TUI_STYLE.system.dim).toBe(true);
    expect(TUI_STYLE.faint.dim).toBe(true);
    expect(TUI_STYLE.border.dim).toBe(true);
    expect(TUI_STYLE.thinking.dim).toBe(true);
    expect(TUI_STYLE.thinking.italic).toBe(true);
  });

  it("uses bold for heading", () => {
    expect(TUI_STYLE.heading.bold).toBe(true);
  });

  it("uses hex fg colors for semantic accents", () => {
    expect(TUI_STYLE.error.fg).toMatch(/^#/);
    expect(TUI_STYLE.success.fg).toMatch(/^#/);
    expect(TUI_STYLE.warning.fg).toMatch(/^#/);
    expect(TUI_STYLE.tool.fg).toMatch(/^#/);
    expect(TUI_STYLE.info.fg).toMatch(/^#/);
    expect(TUI_STYLE.memory.fg).toMatch(/^#/);
  });

  it("exposes launch-lock palette tokens", () => {
    expect(TUI_STYLE.accent.fg).toBe("#c4887a");
    expect(TUI_STYLE.chromeMuted.fg).toBe("#7a8294");
    expect(TUI_STYLE.brand.fg).toBe("#d8dce4");
    expect(TUI_STYLE.onFlag.fg).toBe("#7aaf8a");
  });
});

describe("textAttributesOf", () => {
  it("returns 0 for an empty style", () => {
    expect(textAttributesOf({})).toBe(0);
  });

  it("sets attributes for bold/italic/dim/underline/strikethrough", () => {
    expect(textAttributesOf({ bold: true })).not.toBe(0);
    expect(textAttributesOf({ dim: true })).not.toBe(0);
    expect(textAttributesOf({ italic: true })).not.toBe(0);
    expect(textAttributesOf({ underline: true })).not.toBe(0);
    expect(textAttributesOf({ strikethrough: true })).not.toBe(0);
  });

  it("does not set attributes for fg/bg-only styles", () => {
    expect(textAttributesOf({ fg: "#ff0000" })).toBe(0);
    expect(textAttributesOf({ bg: "#000000" })).toBe(0);
  });
});

describe("truncatePlainText", () => {
  it("truncates plain text to width with an ellipsis", () => {
    expect(truncatePlainText("abcdefghij", 5)).toBe("abcd…");
    expect(visibleTextWidth(truncatePlainText("abcdefghij", 5))).toBe(5);
  });

  it("returns the original when it fits", () => {
    expect(truncatePlainText("abc", 10)).toBe("abc");
  });

  it("handles width 1 and width 0", () => {
    expect(truncatePlainText("abc", 1)).toBe("a");
    expect(truncatePlainText("abc", 0)).toBe("");
  });
});

describe("truncateSegments", () => {
  it("preserves segments that fit within the width", () => {
    const segs: TextSegment[] = [
      { text: "praana", style: { bold: true } },
      { text: " · ", style: { dim: true } },
      { text: "main", style: { dim: true } },
    ];
    expect(truncateSegments(segs, 20)).toEqual(segs);
  });

  it("truncates and appends ellipsis to the last visible segment", () => {
    const segs: TextSegment[] = [
      { text: "praana", style: { bold: true } },
      { text: "long/path/that/overflows", style: { dim: true } },
    ];
    const out = truncateSegments(segs, 12);
    expect(visibleTextWidth(segmentsToPlainText(out))).toBeLessThanOrEqual(12);
    expect(out[out.length - 1].text).toContain("…");
    expect(segmentsToPlainText(out)).toContain("praana");
  });

  it("preserves per-segment styles in the output", () => {
    const segs: TextSegment[] = [
      { text: "bold", style: { bold: true } },
      { text: "dim", style: { dim: true } },
    ];
    const out = truncateSegments(segs, 10);
    expect(out[0].style?.bold).toBe(true);
    expect(out[1].style?.dim).toBe(true);
  });

  it("handles width 0", () => {
    expect(truncateSegments([{ text: "abc" }], 0)).toEqual([]);
  });
});

describe("segmentsToPlainText", () => {
  it("joins segment texts without styling", () => {
    const segs: TextSegment[] = [
      { text: "praana", style: { bold: true } },
      { text: " · ", style: { dim: true } },
      { text: "main" },
    ];
    expect(segmentsToPlainText(segs)).toBe("praana · main");
  });
});

describe("zonesEnabled", () => {
  it("returns false when NO_COLOR is set", () => {
    const orig = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      expect(zonesEnabled(true)).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = orig;
    }
  });

  it("respects the config flag", () => {
    const orig = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      expect(zonesEnabled(true)).toBe(true);
      expect(zonesEnabled(false)).toBe(false);
    } finally {
      if (orig !== undefined) process.env.NO_COLOR = orig;
    }
  });
});
