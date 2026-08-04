import { describe, it, expect } from "bun:test";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import {
  EDITOR_BORDER_STYLE,
  paintZoneLine,
  TUI_STYLE,
  truncatePlainText,
  visibleTextWidth,
} from "../src/ui/tui/theme.js";

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

describe("EDITOR_BORDER_STYLE", () => {
  it("hides OpenTUI editor border rules in the terminal-native TUI", () => {
    expect(EDITOR_BORDER_STYLE("────")).toBe("");
  });
});

describe("truncatePlainText", () => {
  it("truncates plain text to width with an ellipsis", () => {
    expect(truncatePlainText("abcdefghij", 5)).toBe("abcd…");
    expect(visibleTextWidth(truncatePlainText("abcdefghij", 5))).toBe(5);
  });

  it("does not split ANSI escape sequences when truncating styled text", () => {
    const styled = chalk.bold("praana") + chalk.dim(" · ") + chalk.cyan("x".repeat(40));
    const out = truncatePlainText(styled, 20);
    expect(visibleTextWidth(out)).toBeLessThanOrEqual(20);
    // No orphaned CSI introducer without a terminating 'm'
    expect(out).not.toMatch(/\x1b\[[0-9;]*$/);
    expect(stripAnsi(out)).toContain("praana");
  });
});

describe("paintZoneLine", () => {
  it("truncates long plain lines when background zones are disabled", () => {
    const width = 40;
    const line = "x".repeat(80);
    const out = paintZoneLine(line, "canvas", false, width);
    expect(visibleTextWidth(out)).toBeLessThanOrEqual(width);
  });

  it("truncates chalk-styled lines without breaking escapes", () => {
    const width = 24;
    const line = chalk.bold("praana") + chalk.dim(" · long/path/that/overflows");
    const out = paintZoneLine(line, "chrome", false, width);
    expect(visibleTextWidth(out)).toBeLessThanOrEqual(width);
    expect(out).not.toMatch(/\x1b\[[0-9;]*$/);
  });

  it("does not force background colors when background zones are enabled", () => {
    const out = paintZoneLine("terminal-owned", "canvas", true, 40);
    expect(out).toBe("terminal-owned");
  });
});
