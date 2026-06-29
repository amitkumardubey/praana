import type { Buffer } from "../core/buffer.js";
import type { Rect } from "../core/rect.js";
import type { Style } from "../core/style.js";
import { Modifier, styleAddModifier } from "../core/style.js";
import type { StatefulWidget } from "./widget.js";

export interface ListState {
  items: string[];
  selected: number;
  offset: number;
}

export function createListState(items: string[], selected = 0): ListState {
  return { items, selected, offset: 0 };
}

export function listWidget(style: Style = {}): StatefulWidget<ListState> {
  const itemStyle = style;
  const selectedStyle = styleAddModifier(styleAddModifier({}, Modifier.BOLD), Modifier.REVERSED);

  return {
    render(area: Rect, buf: Buffer, state: ListState) {
      const visible = area.height;
      let offset = state.offset;
      if (state.selected < offset) {
        offset = state.selected;
      } else if (state.selected >= offset + visible) {
        offset = state.selected - visible + 1;
      }

      for (let row = 0; row < visible; row++) {
        const idx = offset + row;
        if (idx >= state.items.length) break;
        const item = state.items[idx]!;
        const prefix = idx === state.selected ? "› " : "  ";
        const s = idx === state.selected ? selectedStyle : itemStyle;
        buf.setString(area.x, area.y + row, prefix + item, s, area.width);
      }
    },
  };
}

export function listSelectNext(state: ListState): ListState {
  return {
    ...state,
    selected: Math.min(state.selected + 1, state.items.length - 1),
  };
}

export function listSelectPrev(state: ListState): ListState {
  return {
    ...state,
    selected: Math.max(state.selected - 1, 0),
  };
}
