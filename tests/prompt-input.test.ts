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

  it("continues only at the end of the buffer or at the end of a line", () => {
    // End of buffer: odd run continues, even run submits.
    expect(shouldContinueLine("abc\\", 4)).toBe(true);
    expect(shouldContinueLine("abc\\\\", 5)).toBe(false);
    // Caret immediately before a newline (end of a non-last line).
    expect(shouldContinueLine("abc\\\ndef", 4)).toBe(true);
    expect(shouldContinueLine("abc\\\\\ndef", 5)).toBe(false);
  });

  it("never continues when the caret is mid-line with text after it", () => {
    // `\` mid-text with caret right after it: Enter submits as before.
    expect(shouldContinueLine("a\\b", 2)).toBe(false);
    expect(shouldContinueLine("\\ trailing", 1)).toBe(false);
    expect(shouldContinueLine("abc\\x", 4)).toBe(false);
    expect(shouldContinueLine("abc\\\\x", 5)).toBe(false);
  });

  it("continues at the end of a non-last line (caret before a newline)", () => {
    // "echo abc\\\necho def": backslash at index 8, newline at 9.
    expect(shouldContinueLine("echo abc\\\necho def", 9)).toBe(true);
    expect(shouldContinueLine("echo abc\\\necho def", 8)).toBe(false);
    expect(shouldContinueLine("echo abc\\\\\necho def", 10)).toBe(false);
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

describe("cursorOffset is a UTF-16 index into plainText", () => {
  it("round-trips exactly for every UTF-16 index incl. CJK and emoji", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
      const ta = new TextareaRenderable(setup.renderer, {
        id: "probe-offset",
        width: 60,
        height: 5,
      });
      setup.renderer.root.add(ta);
      // CJK chars are one UTF-16 unit each; the emoji is a surrogate pair;
      // the trailing backslash sits on the second line.
      const TEXT = "あいうえお\nカキクケコ😀\\";
      ta.setText(TEXT);
      expect(ta.plainText).toBe(TEXT);
      expect(TEXT.length).toBe(14); // 5 + 1 + 5 + 2 (emoji) + 1

      // Setting any UTF-16 index (including inside the surrogate pair) must
      // round-trip unchanged — cursorOffset indexes by code unit.
      for (let off = 0; off <= TEXT.length; off++) {
        ta.cursorOffset = off;
        expect(ta.cursorOffset).toBe(off);
      }

      // Caret at the end of the buffer = plainText.length; the trailing
      // backslash on the second line is what the continuation sees.
      ta.cursorOffset = TEXT.length;
      expect(ta.cursorOffset).toBe(TEXT.length);
      expect(ta.logicalCursor.offset).toBe(TEXT.length);
      expect(ta.plainText[TEXT.length - 1]).toBe("\\");
      expect(shouldContinueLine(ta.plainText, ta.cursorOffset)).toBe(true);

      // End of a non-last line: the caret sits immediately before the
      // newline, which cursorOffset reports as the newline's UTF-16 index.
      const MULTI = "abc\\\ndef";
      ta.setText(MULTI);
      ta.setCursor(0, 4); // after the backslash, end of line 0
      const nl = MULTI.indexOf("\n");
      expect(ta.cursorOffset).toBe(nl);
      expect(ta.plainText[ta.cursorOffset]).toBe("\n");
      expect(shouldContinueLine(ta.plainText, ta.cursorOffset)).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
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
