/* Colour palette, elevation zones, and syntax themes for the PRAANA pi-tui TUI. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { Theme as HighlightTheme } from "cli-highlight";

// ─── Nord raw palette ──────────────────────────────────────────────────────

export const NORD_COLORS = {
  nord0: "#2E3440",
  nord1: "#3B4252",
  nord2: "#434C5E",
  nord3: "#4C566A",
  nord3b: "#616E88",
  nord4: "#D8DEE9",
  nord5: "#E5E9F0",
  nord6: "#ECEFF4",
  nord7: "#8FBCBB",
  nord8: "#88C0D0",
  nord9: "#81A1C1",
  nord10: "#5E81AC",
  nord11: "#BF616A",
  nord12: "#D08770",
  nord13: "#EBCB8B",
  nord14: "#A3BE8C",
  nord15: "#B48EAD",
} as const;

// ─── Palette type ──────────────────────────────────────────────────────────

export type Palette = {
  user: string;
  assistant: string;
  thinking: string;
  tool: string;
  system: string;
  border: string;
  gutter: string;
  muted: string;
  faint: string;
  warning: string;
  error: string;
  info: string;
  success: string;
  text: string;
  memory: string;
  codeBg: string;
  codeSpanBg: string;
  /** Dim neutral-gray background for user message rows. */
  userBg: string;
  /** Chrome strip (identity + glance). */
  zoneChrome: string;
  /** User, tools, recall, thinking, input. */
  zoneRaised: string;
  /** Assistant prose — calmest surface. */
  zoneCanvas: string;
};

export type TuiTheme = {
  name: string;
  syntaxTheme: string;
  dark: Palette;
  light: Palette;
};

const c = NORD_COLORS;

/** Design §10: blue user · violet memory · amber tools · grey thinking. */
const NORD_DARK: Palette = {
  user: c.nord9,
  assistant: c.nord6,
  thinking: c.nord3b,
  tool: c.nord12,
  system: c.nord4,
  border: c.nord8,
  gutter: c.nord3,
  muted: c.nord4,
  faint: c.nord3b,
  warning: c.nord13,
  error: c.nord11,
  info: c.nord9,
  success: c.nord14,
  text: c.nord6,
  memory: c.nord15,
  codeBg: c.nord0,
  codeSpanBg: c.nord1,
  userBg: "#333333",
  zoneChrome: c.nord1,
  zoneRaised: c.nord2,
  zoneCanvas: c.nord0,
};

const NORD_LIGHT: Palette = {
  user: c.nord10,
  assistant: c.nord0,
  thinking: c.nord3,
  tool: c.nord12,
  system: c.nord3,
  border: c.nord10,
  gutter: c.nord4,
  muted: c.nord3,
  faint: c.nord2,
  warning: c.nord12,
  error: c.nord11,
  info: c.nord10,
  success: c.nord14,
  text: c.nord0,
  memory: c.nord15,
  codeBg: c.nord5,
  codeSpanBg: c.nord4,
  userBg: "#d8d8d8",
  zoneChrome: c.nord4,
  zoneRaised: c.nord5,
  zoneCanvas: c.nord6,
};

export const NORD: TuiTheme = {
  name: "nord",
  syntaxTheme: "nord",
  dark: NORD_DARK,
  light: NORD_LIGHT,
};

export const ACTIVE_THEME: TuiTheme = NORD;
export const PALETTE: Palette = ACTIVE_THEME.dark;

// ─── Elevation zones (design §9) ───────────────────────────────────────────

export type ZoneKind = "chrome" | "raised" | "canvas";

export function zonesEnabled(configOn: boolean): boolean {
  return configOn && !process.env.NO_COLOR && chalk.level >= 1;
}

export function zoneBg(
  kind: ZoneKind,
  enabled: boolean,
): ((text: string) => string) | undefined {
  if (!zonesEnabled(enabled)) return undefined;
  const hex =
    kind === "chrome"
      ? PALETTE.zoneChrome
      : kind === "raised"
        ? PALETTE.zoneRaised
        : PALETTE.zoneCanvas;
  return (text: string) => chalk.bgHex(hex)(text);
}

export function paintZoneLine(
  line: string,
  kind: ZoneKind,
  enabled: boolean,
  width: number,
): string {
  const bg = zoneBg(kind, enabled);
  // Truncate only (no padding) — the built-in pad path in truncateToWidth
  // miscounts double-width emoji by 1, producing a line that is width+1.
  const truncated = truncateToWidth(line, width, "…", false);
  if (!bg) return truncated;
  // Pad using visibleWidth for measurement — this is the same function
  // pi-tui uses to validate rendered lines, so the padding is always exact.
  const actual = visibleWidth(truncated);
  const padding = " ".repeat(Math.max(0, width - actual));
  return bg(truncated + padding);
}

// ─── Nord syntax theme (cli-highlight) ────────────────────────────────────

export const NORD_SYNTAX: HighlightTheme = {
  keyword: chalk.hex(c.nord9),
  built_in: chalk.hex(c.nord7),
  type: chalk.hex(c.nord7),
  literal: chalk.hex(c.nord9),
  number: chalk.hex(c.nord15),
  regexp: chalk.hex(c.nord13),
  string: chalk.hex(c.nord14),
  subst: chalk.hex(c.nord4),
  symbol: chalk.hex(c.nord15),
  class: chalk.hex(c.nord7),
  function: chalk.hex(c.nord8),
  title: chalk.hex(c.nord8),
  params: chalk.hex(c.nord4),
  comment: chalk.hex(c.nord3b),
  doctag: chalk.hex(c.nord3b),
  meta: chalk.hex(c.nord10),
  "meta-keyword": chalk.hex(c.nord9),
  "meta-string": chalk.hex(c.nord14),
  section: chalk.hex(c.nord8),
  tag: chalk.hex(c.nord9),
  name: chalk.hex(c.nord9),
  "builtin-name": chalk.hex(c.nord7),
  attr: chalk.hex(c.nord7),
  attribute: chalk.hex(c.nord7),
  variable: chalk.hex(c.nord4),
  bullet: chalk.hex(c.nord13),
  code: chalk.hex(c.nord8),
  emphasis: (s: string) => chalk.italic(chalk.hex(c.nord4)(s)),
  strong: (s: string) => chalk.bold(chalk.hex(c.nord4)(s)),
  formula: chalk.hex(c.nord8),
  link: chalk.hex(c.nord8),
  quote: chalk.hex(c.nord3b),
  "selector-tag": chalk.hex(c.nord9),
  "selector-id": chalk.hex(c.nord8),
  "selector-class": chalk.hex(c.nord7),
  "selector-attr": chalk.hex(c.nord15),
  "selector-pseudo": chalk.hex(c.nord15),
  "template-tag": chalk.hex(c.nord9),
  "template-variable": chalk.hex(c.nord15),
  addition: chalk.hex(c.nord14),
  deletion: chalk.hex(c.nord11),
  default: chalk.hex(c.nord4),
};

const NAMED_SYNTAX_THEMES: Record<string, HighlightTheme> = {
  nord: NORD_SYNTAX,
  "nord-dark": NORD_SYNTAX,
};

export function resolveSyntaxTheme(name: string): HighlightTheme | string {
  return NAMED_SYNTAX_THEMES[name] ?? name;
}
