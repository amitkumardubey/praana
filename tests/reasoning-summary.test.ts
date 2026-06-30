import { describe, it, expect } from "bun:test";
import {
  formatThinkingDuration,
  reasoningSummary,
  truncateThinkingBody,
} from "../src/ui/tui/reasoning-summary.js";

describe("reasoningSummary", () => {
  it("extracts bold title and body", () => {
    expect(
      reasoningSummary("**Planning fix**\n\nInspect the reducer and tests.")
    ).toEqual({
      title: "Planning fix",
      body: "Inspect the reducer and tests.",
    });
  });

  it("returns null title when no bold header", () => {
    expect(reasoningSummary("Just thinking aloud.")).toEqual({
      title: null,
      body: "Just thinking aloud.",
    });
  });

  it("handles title-only reasoning", () => {
    expect(reasoningSummary("**Quick check**")).toEqual({
      title: "Quick check",
      body: "",
    });
  });
});

describe("formatThinkingDuration", () => {
  it("formats sub-second durations in ms", () => {
    expect(formatThinkingDuration(450)).toBe("450ms");
  });

  it("formats longer durations in seconds", () => {
    expect(formatThinkingDuration(2500)).toBe("2.5s");
  });
});

describe("truncateThinkingBody", () => {
  it("returns full text when within line limit", () => {
    expect(truncateThinkingBody("one\ntwo")).toEqual({
      text: "one\ntwo",
      truncated: false,
    });
  });

  it("truncates beyond max lines", () => {
    const body = "a\nb\nc\nd";
    expect(truncateThinkingBody(body, 2)).toEqual({
      text: "a\nb",
      truncated: true,
    });
  });
});
