import type { Buffer } from "../core/buffer.js";
import type { Rect } from "../core/rect.js";

/** Pure render function: draw into a buffer region. */
export type WidgetRenderer = (area: Rect, buf: Buffer) => void;

export interface Widget {
  render: WidgetRenderer;
}

export function renderWidget(widget: Widget, area: Rect, buf: Buffer): void {
  if (area.width <= 0 || area.height <= 0) return;
  widget.render(area, buf);
}

/** Stateful widget with external state object. */
export interface StatefulWidget<State> {
  render: (area: Rect, buf: Buffer, state: State) => void;
}

export function renderStatefulWidget<State>(
  widget: StatefulWidget<State>,
  area: Rect,
  buf: Buffer,
  state: State
): void {
  if (area.width <= 0 || area.height <= 0) return;
  widget.render(area, buf, state);
}
