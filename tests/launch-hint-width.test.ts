import { describe, it, expect } from "bun:test";
import {
  LAUNCH_HINT_TEXT,
  LAUNCH_HINT_TEXT_SHORT,
  launchHintForWidth,
} from "../src/ui/tui/boot-summary.js";
import { launchHintForTerminalWidth } from "../src/ui/tui/launch-canvas.tsx";

describe("launch canvas hint fallback", () => {
  it("unknown (zero) width falls back to the 80-column short form", () => {
    expect(launchHintForTerminalWidth(0)).toBe(LAUNCH_HINT_TEXT_SHORT);
    expect(launchHintForTerminalWidth(Number.NaN)).toBe(LAUNCH_HINT_TEXT_SHORT);
  });

  it("known widths still pick by column count", () => {
    expect(launchHintForTerminalWidth(80)).toBe(LAUNCH_HINT_TEXT_SHORT);
    expect(launchHintForTerminalWidth(99)).toBe(LAUNCH_HINT_TEXT_SHORT);
    expect(launchHintForTerminalWidth(100)).toBe(LAUNCH_HINT_TEXT);
  });
});

describe("launch first-screen hint is width-aware", () => {
  it("uses the shorter form below 100 columns", () => {
    expect(launchHintForWidth(60)).toBe("Type a message · /help · /model · Ctrl+J = new line");
    expect(launchHintForWidth(80)).toBe("Type a message · /help · /model · Ctrl+J = new line");
    expect(launchHintForWidth(99)).toBe("Type a message · /help · /model · Ctrl+J = new line");
  });

  it("uses the full form at 100 columns and wider", () => {
    expect(launchHintForWidth(100)).toBe(LAUNCH_HINT_TEXT);
    expect(launchHintForWidth(120)).toBe(LAUNCH_HINT_TEXT);
  });

  it("never wraps: the hint fits inside the terminal width for widths 60/80/100/120", () => {
    for (const width of [60, 80, 100, 120]) {
      const hint = launchHintForWidth(width);
      expect(hint.length).toBeLessThanOrEqual(width);
      expect(hint).not.toContain("\n");
      expect(hint).not.toContain("\r");
    }
  });

  it("the full form fits the 100-column terminal it is gated on", () => {
    const full = LAUNCH_HINT_TEXT;
    expect(full.length).toBeLessThanOrEqual(100);
    expect(full.length).toBeGreaterThan(LAUNCH_HINT_TEXT_SHORT.length);
  });
});
