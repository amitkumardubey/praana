import type { Buffer } from "../core/buffer.js";

export interface TerminalBackend {
  readonly width: number;
  readonly height: number;
  /** Write rendered output to the terminal. */
  draw(buffer: Buffer): void;
  /** Resize backend dimensions. */
  resize?(width: number, height: number): void;
}

export interface Terminal {
  backend: TerminalBackend;
  width: number;
  height: number;
}

export function createTerminal(backend: TerminalBackend): Terminal {
  // Getters, not snapshots: terminal.width/height must track backend.resize()
  // so a SIGWINCH-driven resize actually changes the rendered frame size.
  return {
    backend,
    get width() {
      return backend.width;
    },
    get height() {
      return backend.height;
    },
  };
}
