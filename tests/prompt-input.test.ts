import { describe, expect, it } from "vitest";

/**
 * Shortcut routing logic mirrored from PromptInput — empty input consumes `t`.
 */
function shouldConsumeEmptyShortcut(
  key: string,
  inputValue: string,
  busy: boolean
): boolean {
  return key === "t" && inputValue.length === 0 && !busy;
}

describe("PromptInput empty shortcuts", () => {
  it("consumes t when input is empty and not busy", () => {
    expect(shouldConsumeEmptyShortcut("t", "", false)).toBe(true);
  });

  it("does not consume t when input has text", () => {
    expect(shouldConsumeEmptyShortcut("t", "hello", false)).toBe(false);
  });

  it("does not consume t while a turn is running", () => {
    expect(shouldConsumeEmptyShortcut("t", "", true)).toBe(false);
  });

  it("does not consume other keys", () => {
    expect(shouldConsumeEmptyShortcut("x", "", false)).toBe(false);
  });
});
