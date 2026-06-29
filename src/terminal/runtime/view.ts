import type { FrameCallback } from "../render/frame.js";

export interface ViewSpec {
  draw: FrameCallback;
  alternateScreen?: boolean;
  hideCursor?: boolean;
}

export function view(draw: FrameCallback, opts?: { alternateScreen?: boolean; hideCursor?: boolean }): ViewSpec {
  return {
    draw,
    alternateScreen: opts?.alternateScreen,
    hideCursor: opts?.hideCursor ?? true,
  };
}
