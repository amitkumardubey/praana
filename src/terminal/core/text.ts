import type { Style } from "./style.js";

/** A styled text span. */
export interface Span {
  text: string;
  style?: Style;
}

/** A line of styled spans. */
export interface Line {
  spans: Span[];
}

export function span(text: string, style?: Style): Span {
  return { text, style };
}

export function line(...spans: Span[]): Line {
  return { spans };
}

export function plainLine(text: string, style?: Style): Line {
  return { spans: [{ text, style }] };
}

/**
 * Display width of a string in terminal columns.
 * Treats common wide chars (CJK, emoji) as width 2; ASCII as 1.
 */
export function strWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isWide(code)) width += 2;
    else width += 1;
  }
  return width;
}

function isWide(code: number): boolean {
  if (code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )) {
    return true;
  }
  return false;
}

export function lineWidth(line: Line): number {
  let w = 0;
  for (const s of line.spans) w += strWidth(s.text);
  return w;
}

export function lineToPlain(line: Line): string {
  return line.spans.map((s) => s.text).join("");
}
