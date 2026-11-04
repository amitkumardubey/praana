import { describe, expect, test } from "bun:test";
import { fixture, tokenize, responseMode } from "../scripts/tui-probe/mock-llm.js";

describe("streaming probe mock", () => {
  test("fixture exercises markdown and wide text", () => {
    expect((fixture.match(/^\s*- /gm) ?? []).length).toBeGreaterThanOrEqual(12);
    for (const part of ["# ", "- [ ]", "```ts", "```\n", "~~~", "| Name", "> -", "日本語", "😀"]) {
      expect(fixture).toContain(part);
    }
    expect(tokenize(fixture).join("")).toBe(fixture);
  });

  test("preserves keyword behavior and configurable delay", () => {
    expect(responseMode("normal", 7)).toEqual({ delay: 7, stall: false, cut: false });
    expect(responseMode("SLOW stall CUT", 7)).toEqual({ delay: 60, stall: true, cut: true });
  });
});
