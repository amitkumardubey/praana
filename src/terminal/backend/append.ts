import stripAnsi from "strip-ansi";
import { strWidth } from "../core/text.js";
import { Buffer } from "../core/buffer.js";
import type { TerminalBackend } from "./types.js";

export interface AppendBackendState {
  /** Lines committed to scrollback (plain text, may include ANSI). */
  scrollback: string[];
  /** Pinned footer row count (input + status). */
  pinnedRows: number;
  /** Live region lines (rewritten in place). */
  liveLines: string[];
  width: number;
  writes: string[];
  /** Terminal rows the live region currently occupies on screen. */
  renderedLiveCount: number;
}

export function createAppendBackendState(
  width = 80,
  pinnedRows = 2
): AppendBackendState {
  return {
    scrollback: [],
    pinnedRows,
    liveLines: [],
    renderedLiveCount: 0,
    width,
    writes: [],
  };
}

export interface AppendBackend extends TerminalBackend {
  state: AppendBackendState;
  /** Append completed lines to scrollback. */
  appendLines(lines: string[]): void;
  /** Set live region (rewrites pinned area above footer). */
  setLiveLines(lines: string[]): void;
  /** Clear live region. */
  clearLive(): void;
  flush(write?: (data: string) => void): void;
  /** Required override — updates state.width for physicalRows wrapping. */
  resize(width: number, height: number): void;
}

/**
 * Append-mode backend: scrollback grows; live region rewrites in place.
 * Buffer.draw() is used for compatibility but append API is preferred.
 */
export function createAppendBackend(
  state: AppendBackendState,
  opts?: { write?: (data: string) => void }
): AppendBackend {
  const out = opts?.write ?? ((s) => process.stdout.write(s));

  return {
    get state() {
      return state;
    },
    get width() {
      return state.width;
    },
    get height() {
      return process.stdout.rows ?? 24;
    },
    draw(_buffer: Buffer) {
      // Full buffer draw not used in append mode
    },
    resize(width: number, _height: number) {
      state.width = width;
    },
    appendLines(lines: string[]) {
      // Committed scrollback must sit above any live region: erase the region
      // first (cursor returns to its top) so this content is written there and
      // the next setLiveLines() repaints the region below it.
      eraseLiveRegion(state, out);
      state.scrollback.push(...lines);
      for (const line of lines) {
        const data = line.endsWith("\n") ? line : line + "\n";
        state.writes.push(data);
        out(data);
      }
    },
    setLiveLines(lines: string[]) {
      state.liveLines = lines;
      rewriteLive(state, out);
    },
    clearLive() {
      eraseLiveRegion(state, out);
      state.liveLines = [];
    },
    flush(write = out) {
      rewriteLive(state, write);
    },
  };
}

/**
 * Erase the on-screen live region and park the cursor at its top — which is
 * the bottom writing position (column 0, directly below committed scrollback).
 * No-op when nothing is rendered. Never moves above the region, so committed
 * scrollback is never clobbered.
 */
function eraseLiveRegion(state: AppendBackendState, write: (data: string) => void): void {
  if (state.renderedLiveCount <= 0) return;
  const seq = `\x1b[${state.renderedLiveCount}A\x1b[0G\x1b[0J`;
  state.writes.push(seq);
  write(seq);
  state.renderedLiveCount = 0;
}

function physicalRows(line: string, cols: number): number {
  const w = strWidth(stripAnsi(line));
  return Math.max(1, Math.ceil(w / cols));
}

function rewriteLive(state: AppendBackendState, write: (data: string) => void): void {
  // Repaint in place: drop the previous region, then write each line followed
  // by CRLF so multi-line content occupies its own rows (the old single-row
  // overwrite collapsed them). Cursor ends parked at the bottom writing
  // position; renderedLiveCount lets the next pass find the region's top.
  eraseLiveRegion(state, write);
  if (state.liveLines.length === 0) return;
  const seq = state.liveLines.map((line) => `${line}\r\n`).join("");
  state.writes.push(seq);
  write(seq);
  // Track physical (wrapped) rows, not logical line count. Each logical line
  // may wrap across ceil(displayWidth/cols) terminal rows. Undercounting here
  // causes ESC[NA to not move the cursor up far enough on the next erase, so
  // the top lines survive and accumulate as visible duplicates.
  state.renderedLiveCount = state.liveLines.reduce(
    (sum, line) => sum + physicalRows(line, state.width),
    0,
  );
}

/** Render pinned footer lines at bottom. */
export function writePinnedFooter(
  backend: AppendBackend,
  lines: string[],
  write?: (data: string) => void
): void {
  const out = write ?? ((s) => process.stdout.write(s));
  const seq = lines.map((l) => `\x1b[2K\x1b[0G${l}\n`).join("");
  backend.state.writes.push(seq);
  out(seq);
}
