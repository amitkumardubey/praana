import { Buffer } from "../core/buffer.js";
import type { Rect } from "../core/rect.js";
import { createRect } from "../core/rect.js";

export interface Frame {
  area: Rect;
  buffer: Buffer;
}

export function createFrame(width: number, height: number): Frame {
  return {
    area: createRect(0, 0, width, height),
    buffer: Buffer.fromSize(width, height),
  };
}

export type FrameCallback = (frame: Frame) => void;
