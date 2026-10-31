/**
 * Prompt key bindings + newline-continuation helpers.
 *
 * Most terminals send the same byte (`\r`) for Enter, Shift+Enter, Ctrl+Enter
 * and Alt+Enter, so only plain Enter can be relied on to submit; every other
 * Enter variant inserts a newline. Ctrl+J (`\n`, "linefeed") is the one
 * reliable escape that terminals send distinct from Enter — it also inserts a
 * newline. A single trailing `\` at the caret continues the line on plain
 * Enter (so multi-line commands can be typed without the modifier keys).
 */
import type { KeyBinding } from "@opentui/core";

/** Bindings applied to the prompt textarea. Plain Enter submits; all other
 *  Enter variants insert a newline. */
export const SUBMIT_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  // Ctrl+J produces a literal LF (\n) in every terminal — never submit on it.
  { name: "linefeed", action: "newline" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "kpenter", ctrl: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "kpenter", meta: true, action: "newline" },
];

/**
 * True when pressing Enter at `caret` should continue the line instead of
 * submitting: an odd run of backslashes immediately before the caret (a
 * single trailing `\` escapes the newline). Even runs (`\\`, `\\\\`, …)
 * submit normally.
 */
export function shouldContinueLine(text: string, caret: number): boolean {
  let backslashes = 0;
  for (let i = caret - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Buffer edit for a continued line: drop the terminating `\` before the
 * caret (the caller then inserts the newline). Returns the new buffer text
 * and caret position.
 */
export function applyBackslashContinue(
  text: string,
  caret: number,
): { text: string; caret: number } {
  return {
    text: `${text.slice(0, caret - 1)}${text.slice(caret)}`,
    caret: caret - 1,
  };
}
