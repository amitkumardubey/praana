import { describe, it, expect } from "bun:test";
import stripAnsi from "strip-ansi";
import { SlashCommandResultOverlay } from "../src/ui/tui/slash-command-overlay.js";

describe("SlashCommandResultOverlay", () => {
  it("renders a bordered box around the command output", () => {
    const overlay = new SlashCommandResultOverlay();
    overlay.setLines(["hello", "world"]);

    const lines = overlay.render(40).map(stripAnsi);

    expect(lines[0]).toStartWith("╭");
    expect(lines[0]).toEndWith("╮");
    expect(lines[lines.length - 1]).toStartWith("╰");
    expect(lines[lines.length - 1]).toEndWith("╯");
    expect(lines.some((line) => line.includes("hello"))).toBe(true);
    expect(lines.some((line) => line.includes("world"))).toBe(true);
  });

  it("renders a footer hint to close the overlay", () => {
    const overlay = new SlashCommandResultOverlay();
    overlay.setLines(["output"]);

    const lines = overlay.render(60).map(stripAnsi);

    expect(lines.some((line) => line.includes("Press Enter or Esc to close"))).toBe(
      true,
    );
  });

  it("wraps long lines to fit the overlay width", () => {
    const overlay = new SlashCommandResultOverlay();
    const longLine = "a".repeat(100);
    overlay.setLines([longLine]);

    const width = 40;
    const lines = overlay.render(width).map(stripAnsi);
    const contentLines = lines.filter((line) => line.includes("a"));

    expect(contentLines.length).toBeGreaterThan(1);
    for (const line of contentLines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
    }
  });

  it("renders an empty placeholder when no lines are set", () => {
    const overlay = new SlashCommandResultOverlay();

    const lines = overlay.render(40).map(stripAnsi);

    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines[0]).toStartWith("╭");
    expect(lines[lines.length - 1]).toStartWith("╰");
  });
});
