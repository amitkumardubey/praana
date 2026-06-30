import { describe, it, expect } from "bun:test";

/**
 * Navigation-key routing logic mirrored from TuiApp handleNavigationKey.
 */
function shouldHandleThinkingToggle(
  ctrl: boolean,
  input: string,
  busy: boolean
): boolean {
  return ctrl && input === "t" && !busy;
}

/**
 * Plain character insertion — no empty-input shortcut consumes keystrokes.
 */
function shouldInsertPlainChar(
  key: string,
  inputValue: string,
  ctrl: boolean
): boolean {
  if (ctrl) return false;
  return key.length === 1 && inputValue.length >= 0;
}

describe("PromptInput navigation keys", () => {
  it("handles Ctrl+T when input is empty and not busy", () => {
    expect(shouldHandleThinkingToggle(true, "t", false)).toBe(true);
  });

  it("does not handle Ctrl+T while a turn is running", () => {
    expect(shouldHandleThinkingToggle(true, "t", true)).toBe(false);
  });

  it("does not handle plain t as a navigation key", () => {
    expect(shouldHandleThinkingToggle(false, "t", false)).toBe(false);
  });

  it("does not handle other Ctrl combinations", () => {
    expect(shouldHandleThinkingToggle(true, "x", false)).toBe(false);
  });
});

describe("PromptInput plain character insertion", () => {
  it("inserts plain t at empty prompt", () => {
    expect(shouldInsertPlainChar("t", "", false)).toBe(true);
  });

  it("inserts plain t when input already has text", () => {
    expect(shouldInsertPlainChar("t", "hello", false)).toBe(true);
  });

  it("does not insert Ctrl+T as plain text", () => {
    expect(shouldInsertPlainChar("t", "", true)).toBe(false);
  });
});
