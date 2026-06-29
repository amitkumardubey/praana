/** Bitflags for text modifiers. */
export const Modifier = {
  BOLD: 1 << 0,
  DIM: 1 << 1,
  ITALIC: 1 << 2,
  UNDERLINE: 1 << 3,
  REVERSED: 1 << 4,
  STRIKETHROUGH: 1 << 5,
} as const;

export type ModifierFlags = number;

export interface Style {
  fg?: string;
  bg?: string;
  modifiers?: ModifierFlags;
}

export function createStyle(): Style {
  return {};
}

export function styleFg(style: Style, fg: string): Style {
  return { ...style, fg };
}

export function styleBg(style: Style, bg: string): Style {
  return { ...style, bg };
}

export function styleAddModifier(style: Style, mod: ModifierFlags): Style {
  return { ...style, modifiers: (style.modifiers ?? 0) | mod };
}

export function patchStyle(base: Style, patch: Style): Style {
  return {
    fg: patch.fg ?? base.fg,
    bg: patch.bg ?? base.bg,
    modifiers: patch.modifiers ?? base.modifiers,
  };
}

/** Convert a Style to ANSI escape sequence prefix (no reset). */
export function styleToAnsi(style: Style): string {
  const parts: string[] = [];
  if (style.fg) parts.push(`\x1b[38;2;${hexToRgb(style.fg)}m`);
  if (style.bg) parts.push(`\x1b[48;2;${hexToRgb(style.bg)}m`);
  const mods = style.modifiers ?? 0;
  if (mods & Modifier.BOLD) parts.push("\x1b[1m");
  if (mods & Modifier.DIM) parts.push("\x1b[2m");
  if (mods & Modifier.ITALIC) parts.push("\x1b[3m");
  if (mods & Modifier.UNDERLINE) parts.push("\x1b[4m");
  if (mods & Modifier.REVERSED) parts.push("\x1b[7m");
  if (mods & Modifier.STRIKETHROUGH) parts.push("\x1b[9m");
  return parts.join("");
}

export const RESET_ANSI = "\x1b[0m";

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r};${g};${b}`;
}
