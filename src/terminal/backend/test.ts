import { Buffer } from "../core/buffer.js";
import type { TerminalBackend } from "./types.js";
import { cellsEqual } from "../core/cell.js";
import { RESET_ANSI, styleToAnsi } from "../core/style.js";

export interface TestBackendState {
  width: number;
  height: number;
  buffer: Buffer;
  writes: string[];
}

export function createTestBackendState(width: number, height: number): TestBackendState {
  return {
    width,
    height,
    buffer: Buffer.fromSize(width, height),
    writes: [],
  };
}

export function createTestBackend(state: TestBackendState): TerminalBackend {
  return {
    get width() {
      return state.width;
    },
    get height() {
      return state.height;
    },
    draw(buffer: Buffer) {
      state.buffer = buffer.clone();
    },
    resize(width: number, height: number) {
      state.width = width;
      state.height = height;
      state.buffer = Buffer.fromSize(width, height);
    },
  };
}

/** Render buffer to plain text for snapshot tests (no ANSI). */
export function testBackendToString(state: TestBackendState): string {
  const { buffer } = state;
  const lines: string[] = [];
  for (let y = 0; y < buffer.height; y++) {
    let line = "";
    for (let x = 0; x < buffer.width; x++) {
      line += buffer.get(x, y).char;
    }
    lines.push(line.replace(/\s+$/u, ""));
  }
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

/** Diff two buffers and produce ANSI output string (for TTY backend). */
export function bufferDiffToAnsi(
  prev: Buffer | null,
  next: Buffer,
  cursorHidden = true
): string {
  const parts: string[] = [];
  if (cursorHidden) parts.push("\x1b[?25l");

  let currentStyle = "";
  for (let y = 0; y < next.height; y++) {
    for (let x = 0; x < next.width; x++) {
      const cell = next.get(x, y);
      const prevCell = prev?.get(x, y);
      if (prev && prevCell && cellsEqual(cell, prevCell)) continue;

      parts.push(`\x1b[${y + 1};${x + 1}H`);
      const ansi = styleToAnsi(cell.style);
      if (ansi !== currentStyle) {
        parts.push(ansi);
        currentStyle = ansi;
      }
      parts.push(cell.char);
    }
  }
  parts.push(RESET_ANSI);
  return parts.join("");
}

export function recordWrite(state: TestBackendState, data: string): void {
  state.writes.push(data);
}
