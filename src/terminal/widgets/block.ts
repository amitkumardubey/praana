import type { Buffer } from "../core/buffer.js";
import type { Rect } from "../core/rect.js";
import { rectInner } from "../core/rect.js";
import type { Style } from "../core/style.js";
import { Modifier, styleAddModifier } from "../core/style.js";
import type { Widget, WidgetRenderer } from "./widget.js";

export type BorderStyle = "none" | "rounded" | "plain";

export interface BlockConfig {
  border?: BorderStyle;
  title?: string;
  padding?: number;
  style?: Style;
  borderStyle?: Style;
}

const BORDER_CHARS = {
  plain: {
    tl: "┌", tr: "┐", bl: "└", br: "┘",
    h: "─", v: "│",
  },
  rounded: {
    tl: "╭", tr: "╮", bl: "╰", br: "╯",
    h: "─", v: "│",
  },
} as const;

export function block(config: BlockConfig = {}): Widget {
  return { render: renderBlock(config) };
}

export function renderBlock(config: BlockConfig): WidgetRenderer {
  return (area, buf) => {
    const border = config.border ?? "plain";
    if (border === "none") return;

    const bstyle = config.borderStyle ?? styleAddModifier({}, Modifier.DIM);
    const chars = BORDER_CHARS[border];

    const { x, y, width, height } = area;
    if (width < 2 || height < 2) return;

    // Corners
    buf.setChar(x, y, chars.tl, bstyle);
    buf.setChar(x + width - 1, y, chars.tr, bstyle);
    buf.setChar(x, y + height - 1, chars.bl, bstyle);
    buf.setChar(x + width - 1, y + height - 1, chars.br, bstyle);

    // Horizontal edges
    for (let dx = 1; dx < width - 1; dx++) {
      buf.setChar(x + dx, y, chars.h, bstyle);
      buf.setChar(x + dx, y + height - 1, chars.h, bstyle);
    }
    // Vertical edges
    for (let dy = 1; dy < height - 1; dy++) {
      buf.setChar(x, y + dy, chars.v, bstyle);
      buf.setChar(x + width - 1, y + dy, chars.v, bstyle);
    }

    // Title on top border
    if (config.title && width > 4) {
      const title = config.title.slice(0, width - 4);
      const titleStyle = config.style ?? {};
      buf.setString(x + 2, y, title, titleStyle);
    }
  };
}

/** Inner content area inside a bordered block. */
export function blockInner(area: Rect, config: BlockConfig = {}): Rect {
  const border = config.border ?? "plain";
  const pad = config.padding ?? 0;
  if (border === "none") {
    return rectInner(area, pad);
  }
  const inner = {
    x: area.x + 1,
    y: area.y + 1,
    width: Math.max(0, area.width - 2),
    height: Math.max(0, area.height - 2),
  };
  return rectInner(inner, pad);
}
