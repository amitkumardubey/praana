import type { Style } from "./style.js";

/** A single terminal cell. */
export interface Cell {
  char: string;
  style: Style;
}

export function emptyCell(): Cell {
  return { char: " ", style: {} };
}

export function cell(char: string, style: Style = {}): Cell {
  // First code point only; `[...]` is surrogate-aware so astral chars
  // (emoji, CJK extensions) survive intact. An empty string is preserved as
  // the wide-character continuation marker (see Buffer.setString / diff).
  const cp = [...char][0];
  return { char: cp ?? "", style };
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.char === b.char &&
    a.style.fg === b.style.fg &&
    a.style.bg === b.style.bg &&
    a.style.modifiers === b.style.modifiers
  );
}
