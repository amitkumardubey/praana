/* Terminal-native semantic styling for the PRAANA OpenTUI-based TUI.
 * Styles are plain data objects (SpanStyle) consumed directly by native
 * OpenTUI props: `fg`/`bg`/`attributes` on <text>, or the `style` prop on
 * <span>. Nothing here ever produces ANSI escape strings — OpenTUI's text
 * buffer only ever sees plain text plus native color/attribute state. */
import { createTextAttributes } from "@opentui/core";
import type { Theme as HighlightTheme } from "cli-highlight";

/** A single semantic style, applied via <text fg/bg/attributes> or <span style>. */
export interface SpanStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}

const EMPTY: SpanStyle = {};

/**
 * Semantic TUI styles that defer the main palette to the user's terminal.
 * Only exceptional states use standard colors.
 */
/** Locked launch-screen palette (design-proto/LAUNCH-LOCK.md). */
export const TUI_PALETTE = {
  coral: "#c4887a",
  steelMuted: "#7a8294",
  brand: "#d8dce4",
  onFlag: "#7aaf8a",
  inset: "#262830",
} as const;

export const TUI_STYLE = {
  text: EMPTY,
  user: EMPTY,
  assistant: EMPTY,
  system: { dim: true },
  muted: { dim: true },
  faint: { dim: true },
  /** Explicit steel muted for identity / ambient glance (not terminal-dim). */
  chromeMuted: { fg: TUI_PALETTE.steelMuted },
  heading: { bold: true },
  thinking: { dim: true, italic: true },
  tool: { fg: "#e5c07b" },
  info: { fg: "#56b6c2" },
  memory: { fg: "#c678dd" },
  warning: { fg: "#e5c07b" },
  error: { fg: "#e06c75" },
  success: { fg: "#98c379" },
  /** Coral accent — prompt glyph + launch pulse only. */
  accent: { fg: TUI_PALETTE.coral },
  /** Brand light — ASCII wordmark. */
  brand: { fg: TUI_PALETTE.brand },
  /** Green “systems on” flags (engine / mem). */
  onFlag: { fg: TUI_PALETTE.onFlag },
  border: { dim: true },
} as const satisfies Record<string, SpanStyle>;

/** Compute the OpenTUI `attributes` bitmask for a SpanStyle (bold/italic/underline/dim/strikethrough). */
export function textAttributesOf(style: SpanStyle): number {
  return createTextAttributes({
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    dim: style.dim,
    strikethrough: style.strikethrough,
  });
}

// ─── Elevation zones (design §9) ───────────────────────────────────────────
// Background zones are not yet implemented against the native renderer;
// these stay as inert hooks so callers can pass the config flag through
// without branching on it themselves.

export type ZoneKind = "chrome" | "raised" | "canvas";

export function zonesEnabled(configOn: boolean): boolean {
  return configOn && !process.env.NO_COLOR;
}

/** Visible length of a plain-text string (no ANSI is ever embedded now). */
export function visibleTextWidth(text: string): number {
  return text.length;
}

/** Truncate plain text to `width` visible characters, appending an ellipsis. */
export function truncatePlainText(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return text.slice(0, 1);
  return `${text.slice(0, width - 1)}…`;
}

/** A styled text segment — the unit rendered as `<span style={style}>{text}</span>`. */
export interface TextSegment {
  text: string;
  style?: SpanStyle;
}

/** Truncate an ordered list of styled segments to a total visible `width`,
 *  preserving per-segment styling and appending an ellipsis to the last
 *  visible segment when truncation occurs. */
export function truncateSegments(segments: TextSegment[], width: number): TextSegment[] {
  if (width <= 0) return [];
  const totalWidth = segments.reduce((sum, seg) => sum + seg.text.length, 0);
  if (totalWidth <= width) return segments;

  const target = width === 1 ? 1 : width - 1;
  const out: TextSegment[] = [];
  let remaining = target;
  for (const seg of segments) {
    if (remaining <= 0) break;
    if (seg.text.length <= remaining) {
      out.push(seg);
      remaining -= seg.text.length;
    } else {
      out.push({ text: seg.text.slice(0, remaining), style: seg.style });
      remaining = 0;
    }
  }
  if (width > 1) {
    const last = out[out.length - 1];
    if (last) last.text += "…";
    else out.push({ text: "…" });
  }
  return out;
}

/** Plain-text (no styling) representation of a segment list, for width math
 *  and non-JSX callers that only need the raw string. */
export function segmentsToPlainText(segments: TextSegment[]): string {
  return segments.map((s) => s.text).join("");
}

export function resolveSyntaxTheme(name: string): HighlightTheme | string {
  return name;
}
