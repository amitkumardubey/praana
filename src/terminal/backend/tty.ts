import { Buffer } from "../core/buffer.js";
import { diffBuffers } from "../render/diff.js";
import type { TerminalBackend } from "./types.js";

export interface TtyBackendOptions {
  write?: (data: string) => void;
  width?: number;
  height?: number;
}

/**
 * TTY backend: diffs buffers and writes ANSI to stdout.
 */
export function createTtyBackend(opts: TtyBackendOptions = {}): TerminalBackend & {
  lastBuffer: Buffer | null;
} {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  let width = opts.width ?? process.stdout.columns ?? 80;
  let height = opts.height ?? process.stdout.rows ?? 24;
  let lastBuffer: Buffer | null = null;

  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    // Backed by the same closure variable draw()/resize() use, so callers can
    // force a full redraw with `backend.lastBuffer = null` (e.g. invalidate()).
    get lastBuffer() {
      return lastBuffer;
    },
    set lastBuffer(value: Buffer | null) {
      lastBuffer = value;
    },
    draw(buffer: Buffer) {
      const { output } = diffBuffers(lastBuffer, buffer);
      if (output.length > 0) write(output);
      lastBuffer = buffer.clone();
    },
    resize(w: number, h: number) {
      width = w;
      height = h;
      lastBuffer = null;
    },
  };
}
