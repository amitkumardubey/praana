import type { Buffer } from "../core/buffer.js";
import type { Rect } from "../core/rect.js";
import type { Style } from "../core/style.js";
import type { Widget, WidgetRenderer } from "./widget.js";

export function clear(style: Style = {}): Widget {
  return { render: renderClear(style) };
}

export function renderClear(style: Style = {}): WidgetRenderer {
  return (area, buf) => {
    buf.fill(area, " ", style);
  };
}
