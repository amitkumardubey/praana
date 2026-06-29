import type { Buffer } from "../core/buffer.js";
import type { Rect } from "../core/rect.js";
import type { Style } from "../core/style.js";
import type { Line } from "../core/text.js";
import { lineToPlain, lineWidth, strWidth } from "../core/text.js";
import type { Widget, WidgetRenderer } from "./widget.js";
import { block, blockInner, type BlockConfig } from "./block.js";

export interface ParagraphConfig {
  text?: string;
  lines?: Line[];
  style?: Style;
  wrap?: boolean;
  block?: BlockConfig;
}

export function paragraph(config: ParagraphConfig): Widget {
  return { render: renderParagraph(config) };
}

export function renderParagraph(config: ParagraphConfig): WidgetRenderer {
  return (area, buf) => {
    let inner = area;
    if (config.block) {
      block(config.block).render(area, buf);
      inner = blockInner(area, config.block);
    }
    if (inner.width <= 0 || inner.height <= 0) return;

    const rawLines = config.lines ?? (
      config.text ? wrapText(config.text, inner.width, config.wrap !== false) : []
    );

    const style = config.style ?? {};
    for (let row = 0; row < Math.min(rawLines.length, inner.height); row++) {
      const line = rawLines[row]!;
      if (typeof line === "string") {
        buf.setString(inner.x, inner.y + row, line, style, inner.width);
      } else {
        let col = inner.x;
        for (const span of line.spans) {
          col = buf.setString(col, inner.y + row, span.text, span.style ?? style, inner.width - (col - inner.x));
        }
      }
    }
  };
}

export function wrapText(text: string, width: number, wrap = true): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const para of paragraphs) {
    if (!wrap || strWidth(para) <= width) {
      lines.push(para);
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const word of para.split(/(\s+)/)) {
      const w = strWidth(word);
      if (currentWidth + w > width && current.length > 0) {
        lines.push(current.trimEnd());
        current = word;
        currentWidth = w;
      } else {
        current += word;
        currentWidth += w;
      }
    }
    if (current.length > 0) lines.push(current.trimEnd());
  }
  return lines;
}

export function linesFromStrings(strings: string[], style?: Style): Line[] {
  return strings.map((s) => ({ spans: [{ text: s, style }] }));
}

export { lineToPlain, lineWidth };
