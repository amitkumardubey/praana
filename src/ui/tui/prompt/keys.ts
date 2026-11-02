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
 *
 * Continuation only fires at the end of a line: the caret must be at the
 * end of the buffer or immediately before a newline (end of the current
 * line). A backslash elsewhere mid-line submits as before.
 */
/**
 * Display columns occupied by `text`. OpenTUI's `cursorOffset` (and the
 * logical/visual cursor `.offset`) counts display columns — not string
 * indexes — with a newline counting as 1. Walk the text by grapheme and
 * sum each grapheme's width; a zero-width grapheme still counts as at
 * least 1 so the walk always progresses.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const g of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    width += g.segment === "\n" ? 1 : Math.max(1, Bun.stringWidth(g.segment));
  }
  return width;
}

/**
 * String index where the cumulative display width reaches `displayOffset`,
 * clamped to text.length. Used to convert OpenTUI's display-column caret into
 * a string index for buffer logic.
 */
export function displayOffsetToIndex(text: string, displayOffset: number): number {
  if (!Number.isFinite(displayOffset) || displayOffset <= 0) return 0;
  let width = 0;
  let index = 0;
  for (const g of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    width += g.segment === "\n" ? 1 : Math.max(1, Bun.stringWidth(g.segment));
    index += g.segment.length;
    if (width >= displayOffset) return index;
  }
  return text.length;
}

export function shouldContinueLine(text: string, caret: number): boolean {
  if (caret < text.length && text[caret] !== "\n") return false;
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
