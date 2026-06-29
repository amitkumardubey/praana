import type { Terminal } from "./backend/types.js";
import { createFrame, type FrameCallback } from "./render/frame.js";
import { Buffer } from "./core/buffer.js";
import { renderWidget, type Widget } from "./widgets/widget.js";

/** Draw widgets into a frame and flush buffer to backend. */
export function terminalDrawBuffer(terminal: Terminal, draw: FrameCallback): Buffer {
  const frame = createFrame(terminal.width, terminal.height);
  draw(frame);
  terminal.backend.draw(frame.buffer);
  return frame.buffer;
}

export function terminalDrawWidget(terminal: Terminal, widget: Widget): Buffer {
  return terminalDrawBuffer(terminal, (frame) => {
    renderWidget(widget, frame.area, frame.buffer);
  });
}

export { createFrame } from "./render/frame.js";
