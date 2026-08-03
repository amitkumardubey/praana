/** Plain-text wrap/accent helpers for transcript components.
 * OpenTUI's renderer handles ANSI-aware width math internally; these helpers
 * exist only for components that need pre-split text lines. */
import { TUI_STYLE } from "../theme.js";

export type TextStyle = (text: string) => string;

/** Split text at width boundaries, preserving embedded ANSI codes only when
 *  they span the boundary (rare here — callers pass plain or lightly-styled text).
 *  OpenTUI's own TextRenderable wraps at its own width; this is used for
 *  pre-splitting in tool-row bodies and similar. */
export function wrapContent(
  text: string,
  width: number,
  color: TextStyle = TUI_STYLE.text,
): string[] {
  if (width <= 0) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width && current) {
      lines.push(color(current));
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(color(current));
  return lines.length > 0 ? lines : [color(text)];
}

/** No-op passthrough; accent bars are handled by OpenTUI layout (zones disabled). */
export function renderAccentLines(
  lines: string[],
  _role: string,
  _zone: string,
  _showBorder: boolean,
  _width: number,
): string[] {
  return lines;
}
