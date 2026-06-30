import { describe, it, expect } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { paintZoneLine, TUI_STYLE } from "../src/ui/tui/theme.js";

describe("TUI_STYLE", () => {
  it("leaves normal text to the terminal default theme", () => {
    expect(TUI_STYLE.text("hello")).toBe("hello");
  });

  it("does not use fixed RGB colors for semantic accents", () => {
    const rendered = [
      TUI_STYLE.error("error"),
      TUI_STYLE.warning("warning"),
      TUI_STYLE.success("success"),
      TUI_STYLE.tool("tool"),
      TUI_STYLE.muted("muted"),
    ].join("\n");

    expect(rendered).not.toMatch(/\u001b\[(?:38|48);2;/);
    expect(stripAnsi(rendered)).toContain("error");
  });
});

describe("paintZoneLine", () => {
  it("never exceeds terminal width with emoji and bold markdown styling", () => {
    const width = 125;
    const bar = chalk.hex("#88C0D0")("▌");
    const line = `${bar} ${chalk.bold("🎩")}`;
    const painted = paintZoneLine(line, "canvas", true, width);
    expect(visibleWidth(painted)).toBeLessThanOrEqual(width);
  });

  it("truncates long lines when background zones are disabled", () => {
    const width = 40;
    const line = "x".repeat(80);
    const out = paintZoneLine(line, "canvas", false, width);
    expect(visibleWidth(out)).toBeLessThanOrEqual(width);
  });

  it("does not force background colors when background zones are enabled", () => {
    const out = paintZoneLine("terminal-owned", "canvas", true, 40);
    expect(out).toBe("terminal-owned");
  });
});
