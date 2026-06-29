import { Buffer } from "../core/buffer.js";
import { cellsEqual } from "../core/cell.js";
import { RESET_ANSI, styleToAnsi } from "../core/style.js";

export interface DiffResult {
  /** ANSI escape sequence to apply changes. */
  output: string;
  /** Number of cells that changed. */
  changedCells: number;
}

/**
 * Compute minimal ANSI diff between two buffers.
 * Moves cursor per changed cell (simple but correct for small terminals).
 */
export function diffBuffers(prev: Buffer | null, next: Buffer): DiffResult {
  if (!prev) {
    return { output: bufferToAnsiFull(next), changedCells: next.width * next.height };
  }

  const parts: string[] = ["\x1b[?25l"];
  let changedCells = 0;
  let currentStyleKey = styleKeyFor({});

  for (let y = 0; y < next.height; y++) {
    for (let x = 0; x < next.width; x++) {
      const cell = next.get(x, y);
      // Wide-char continuation marker: the lead cell's glyph already covers
      // this column, so emit nothing (writing here would chop the glyph).
      if (cell.char === "") continue;
      const prevCell = prev.get(x, y);
      if (cellsEqual(cell, prevCell)) continue;
      changedCells++;

      parts.push(`\x1b[${y + 1};${x + 1}H`);
      const styleKey = styleKeyFor(cell.style);
      if (styleKey !== currentStyleKey) {
        // Reset first so attributes from the previously-written cell (color,
        // bold, …) never bleed into a cell that clears them.
        parts.push(RESET_ANSI);
        parts.push(styleToAnsi(cell.style));
        currentStyleKey = styleKey;
      }
      parts.push(cell.char);
    }
  }
  if (changedCells === 0) return { output: "", changedCells: 0 };
  parts.push(RESET_ANSI);
  return { output: parts.join(""), changedCells };
}

function styleKeyFor(style: { fg?: string; bg?: string; modifiers?: number }): string {
  return `${style.fg ?? ""}|${style.bg ?? ""}|${style.modifiers ?? 0}`;
}

function bufferToAnsiFull(buf: Buffer): string {
  const parts: string[] = ["\x1b[?25l", "\x1b[2J"];
  let currentStyleKey = styleKeyFor({});
  for (let y = 0; y < buf.height; y++) {
    // Absolute cursor positioning per row — never rely on "\n", which in raw
    // mode is a bare line-feed (no carriage return) and drifts every row right.
    parts.push(`\x1b[${y + 1};1H`);
    for (let x = 0; x < buf.width; x++) {
      const cell = buf.get(x, y);
      if (cell.char === "") continue; // wide-char continuation
      const styleKey = styleKeyFor(cell.style);
      if (styleKey !== currentStyleKey) {
        parts.push(RESET_ANSI);
        parts.push(styleToAnsi(cell.style));
        currentStyleKey = styleKey;
      }
      parts.push(cell.char);
    }
  }
  parts.push(RESET_ANSI);
  return parts.join("");
}

export function clearScreenAnsi(): string {
  return "\x1b[2J\x1b[H";
}

export function showCursorAnsi(show: boolean): string {
  return show ? "\x1b[?25h" : "\x1b[?25l";
}

export function enterAltScreenAnsi(): string {
  return "\x1b[?1049h\x1b[2J\x1b[H";
}

export function leaveAltScreenAnsi(): string {
  return "\x1b[?1049l\x1b[?25h";
}

/**
 * DEC autowrap (DECAWM). When off, writing the last column never wraps or
 * scrolls the screen — required for a full-screen buffer renderer that may
 * touch the bottom-right cell.
 */
export function setAutoWrapAnsi(enabled: boolean): string {
  return enabled ? "\x1b[?7h" : "\x1b[?7l";
}
