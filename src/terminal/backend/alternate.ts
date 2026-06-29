import { createTtyBackend } from "./tty.js";
import type { Terminal } from "./types.js";

export interface AlternateScreenTerminal extends Terminal {
  /** Force full redraw on next frame. */
  invalidate(): void;
}

export function createAlternateTerminal(opts?: {
  write?: (data: string) => void;
  width?: number;
  height?: number;
}): AlternateScreenTerminal {
  const backend = createTtyBackend(opts);
  // Build directly rather than spreading createTerminal(): `{ ...terminal }`
  // would copy the width/height getters into static values and re-freeze them.
  return {
    backend,
    get width() {
      return backend.width;
    },
    get height() {
      return backend.height;
    },
    invalidate() {
      backend.lastBuffer = null;
    },
  };
}
