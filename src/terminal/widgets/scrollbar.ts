import type { Buffer } from "../core/buffer.js";
import type { Rect } from "../core/rect.js";
import type { Style } from "../core/style.js";
import { Modifier, styleAddModifier } from "../core/style.js";
import type { StatefulWidget } from "./widget.js";

export interface ScrollbarState {
  contentLength: number;
  viewportSize: number;
  offset: number;
}

export function createScrollbarState(
  contentLength: number,
  viewportSize: number,
  offset = 0
): ScrollbarState {
  return { contentLength, viewportSize, offset };
}

export function scrollbarWidget(style: Style = {}): StatefulWidget<ScrollbarState> {
  const trackStyle = styleAddModifier(style, Modifier.DIM);
  const thumbStyle = style;

  return {
    render(area: Rect, buf: Buffer, state: ScrollbarState) {
      if (state.contentLength <= state.viewportSize) return;
      const trackLen = area.height;
      const thumbLen = Math.max(1, Math.floor(
        (state.viewportSize / state.contentLength) * trackLen
      ));
      const maxOffset = state.contentLength - state.viewportSize;
      const scrollRatio = maxOffset > 0 ? state.offset / maxOffset : 0;
      const thumbStart = Math.floor(scrollRatio * (trackLen - thumbLen));

      for (let row = 0; row < trackLen; row++) {
        const ch = row >= thumbStart && row < thumbStart + thumbLen ? "█" : "│";
        const s = row >= thumbStart && row < thumbStart + thumbLen ? thumbStyle : trackStyle;
        buf.setChar(area.x, area.y + row, ch, s);
      }
    },
  };
}
