import { describe, expect, it } from "bun:test";
import { RGBA, TextAttributes, type CapturedLine } from "@opentui/core";
import { rawSyntaxLines } from "../scripts/tui-bounce/metrics.js";

function line(text: string, attributes = 0): CapturedLine {
  return { spans: [{ text, attributes, width: text.length, fg: RGBA.fromHex("#ffffff"), bg: RGBA.fromHex("#000000") }] };
}

describe("raw-syntax frame metric", () => {
  it("detects block markers, emphasis pairs/lone markers, backticks and table rules", () => {
    for (const text of ["# Title", " ## Title", "### Title", "**Goals** define results", "**", "- Goals", "* Goals", "Use `code`", "| --- | --- |", "|---|---|"]) {
      expect(rawSyntaxLines([line(text)])).toEqual([text]);
    }
  });

  it("does not count styled bullets, ordered numbers or concealed text", () => {
    expect(rawSyntaxLines([
      line("  - Goals", TextAttributes.DIM),
      line("  * Goals", TextAttributes.DIM),
      line("1. Outcomes"),
      line("Goals", TextAttributes.BOLD),
      line("Title", TextAttributes.BOLD),
      line("const habit = () => readOnePage();"),
      line("│ Habit │ Two-minute version │"),
    ])).toEqual([]);
  });

  it("looks at the marker span rather than the styled body", () => {
    const marker = line("  - ").spans[0]!;
    const body = line("Goals", TextAttributes.BOLD).spans[0]!;
    expect(rawSyntaxLines([{ spans: [marker, body] }])).toHaveLength(1);
    expect(rawSyntaxLines([{ spans: [{ ...marker, attributes: TextAttributes.DIM }, body] }])).toEqual([]);
  });
});
