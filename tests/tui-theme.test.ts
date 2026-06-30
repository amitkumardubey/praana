import { describe, it, expect } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { paintZoneLine } from "../src/ui/tui/theme.js";

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
});
