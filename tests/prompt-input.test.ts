import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable } from "@opentui/core";
import {
  SUBMIT_BINDINGS,
  applyBackslashContinue,
  shouldContinueLine,
} from "../src/ui/tui/prompt/keys.js";
import { PromptHistory } from "../src/ui/tui/prompt/history.js";
import { resetPromptContinuationState } from "../src/ui/tui/prompt/index.js";

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

const bindingFor = (
  name: string,
  mods: Partial<Record<"ctrl" | "shift" | "meta" | "super", boolean>> = {},
) => SUBMIT_BINDINGS.find((b) => b.name === name && (mods.ctrl ?? false) === (b.ctrl ?? false) && (mods.shift ?? false) === (b.shift ?? false) && (mods.meta ?? false) === (b.meta ?? false));

describe("Prompt submit bindings", () => {
  it("keeps plain Enter on return/kpenter as submit", () => {
    expect(bindingFor("return")?.action).toBe("submit");
    expect(bindingFor("kpenter")?.action).toBe("submit");
  });

  it("binds Ctrl+J (linefeed) to newline, not submit", () => {
    const lf = SUBMIT_BINDINGS.find((b) => b.name === "linefeed");
    expect(lf?.action).toBe("newline");
  });

  it("keeps Shift+Enter as newline", () => {
    expect(bindingFor("return", { shift: true })?.action).toBe("newline");
    expect(bindingFor("kpenter", { shift: true })?.action).toBe("newline");
  });

  it("binds Ctrl+Enter to newline", () => {
    expect(bindingFor("return", { ctrl: true })?.action).toBe("newline");
    expect(bindingFor("kpenter", { ctrl: true })?.action).toBe("newline");
  });

  it("binds Alt/Meta+Enter to newline", () => {
    expect(bindingFor("return", { meta: true })?.action).toBe("newline");
    expect(bindingFor("kpenter", { meta: true })?.action).toBe("newline");
  });
});

describe("shouldContinueLine", () => {
  it("returns false for an empty buffer", () => {
    expect(shouldContinueLine("", 0)).toBe(false);
  });

  it("returns true for a single trailing backslash at end of buffer", () => {
    expect(shouldContinueLine("\\", 1)).toBe(true);
    expect(shouldContinueLine("abc\\", 4)).toBe(true);
  });

  it("returns false for an escaped backslash pair at end of buffer", () => {
    expect(shouldContinueLine("abc\\\\", 5)).toBe(false);
  });

  it("returns true for an odd run / false for an even run of backslashes", () => {
    expect(shouldContinueLine("abc\\\\\\", 6)).toBe(true);
    expect(shouldContinueLine("abc\\\\\\\\", 7)).toBe(false);
  });

  it("looks at the run immediately before the caret", () => {
    // `\` mid-text with caret right after it still continues.
    expect(shouldContinueLine("a\\b", 2)).toBe(true);
    // `\\` mid-text with caret after the pair submits.
    expect(shouldContinueLine("a\\\\b", 3)).toBe(false);
  });

  it("is unaffected by text after the caret", () => {
    expect(shouldContinueLine("\\ trailing", 1)).toBe(true);
    expect(shouldContinueLine("abc\\x", 4)).toBe(true);
  });
});

describe("resetPromptContinuationState", () => {
  it("clears the autocomplete popup and history browsing cursor after a continued line", () => {
    const history = new PromptHistory();
    history.push("one");
    history.push("two");
    expect(history.up("draft")).toBe("two");
    expect(history.isBrowsing()).toBe(true);

    let acCleared = false;
    let prevSynced = false;
    resetPromptContinuationState(history, {
      clearAutocomplete: () => {
        acCleared = true;
      },
      syncPrevText: () => {
        prevSynced = true;
      },
    });

    expect(acCleared).toBe(true);
    expect(prevSynced).toBe(true);
    expect(history.isBrowsing()).toBe(false);
    // Browsing afterwards starts from a fresh draft, not a stale cursor.
    expect(history.down()).toBeNull();
  });
});

describe("applyBackslashContinue", () => {
  it("drops the terminating backslash and moves the caret back", () => {
    expect(applyBackslashContinue("abc\\", 4)).toEqual({ text: "abc", caret: 3 });
  });

  it("keeps text after the caret in place", () => {
    expect(applyBackslashContinue("a\\b", 2)).toEqual({ text: "ab", caret: 1 });
  });
});

describe("Prompt textarea key behavior (real OpenTUI key handling)", () => {
  it("plain Enter submits; Ctrl+J (linefeed) inserts a newline", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    let submitted = 0;
    const ta = new TextareaRenderable(setup.renderer, {
      id: "prompt-ta",
      width: 60,
      height: 1,
      keyBindings: SUBMIT_BINDINGS,
      onSubmit: () => {
        submitted += 1;
      },
    });
    setup.renderer.root.add(ta);
    ta.focus();
    await setup.renderOnce();

    setup.mockInput.typeText("ab");
    await setup.renderOnce();
    setup.mockInput.pressKeys(["\n"]); // Ctrl+J
    await setup.renderOnce();
    expect(ta.plainText).toBe("ab\n");
    expect(submitted).toBe(0);

    setup.mockInput.pressEnter();
    await setup.renderOnce();
    expect(submitted).toBe(1);
    setup.renderer.destroy();
  });

  it("Ctrl+Enter, Alt/Meta+Enter and Shift+Enter insert newlines", async () => {
    // otherModifiersMode lets the mock send modifier-distinct Enter sequences
    // (xterm-style modifyOtherKeys), the only way headless tests can tell
    // Ctrl/Alt/Shift+Enter apart from plain Enter.
    const setup = await createTestRenderer({
      width: 80,
      height: 24,
      otherModifiersMode: true,
    });
    let submitted = 0;
    const ta = new TextareaRenderable(setup.renderer, {
      id: "prompt-ta2",
      width: 60,
      height: 1,
      keyBindings: SUBMIT_BINDINGS,
      onSubmit: () => {
        submitted += 1;
      },
    });
    setup.renderer.root.add(ta);
    ta.focus();
    await setup.renderOnce();

    setup.mockInput.pressEnter({ ctrl: true });
    await setup.renderOnce();
    expect(ta.plainText).toBe("\n");
    expect(submitted).toBe(0);

    setup.mockInput.pressEnter({ meta: true });
    await setup.renderOnce();
    expect(ta.plainText).toBe("\n\n");
    expect(submitted).toBe(0);

    setup.mockInput.pressEnter({ shift: true });
    await setup.renderOnce();
    expect(ta.plainText).toBe("\n\n\n");
    expect(submitted).toBe(0);

    setup.mockInput.pressEnter();
    await setup.renderOnce();
    expect(submitted).toBe(1);
    setup.renderer.destroy();
  });
});
