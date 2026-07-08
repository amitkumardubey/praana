import { describe, expect, it } from "bun:test";
import { needsGap } from "../src/ui/tui/transcript/gap.js";

describe("needsGap", () => {
  it("returns false for the first entry", () => {
    expect(needsGap("tool", undefined)).toBe(false);
  });

  it("inserts a gap between consecutive tool rows", () => {
    expect(needsGap("tool", "tool")).toBe(true);
  });

  it("inserts a gap after assistant before tool", () => {
    expect(needsGap("tool", "assistant")).toBe(true);
  });

  it("keeps consecutive thinking blocks tight", () => {
    expect(needsGap("thinking", "thinking")).toBe(false);
  });

  it("keeps consecutive recall chips tight", () => {
    expect(needsGap("recall", "recall")).toBe(false);
  });
});
