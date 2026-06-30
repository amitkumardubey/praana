/* Colour palette + syntax themes for the PRAANA pi-tui TUI.
 *
 * Single file — palette.ts and syntax-themes.ts merged here so there are
 * no intra-tui circular imports and no external consumers need to know the
 * old split.
 */
import chalk from "chalk";
import type { Theme as HighlightTheme } from "cli-highlight";

// ─── Nord raw palette ──────────────────────────────────────────────────────

export const NORD_COLORS = {
  // Polar Night (dark backgrounds)
  nord0: "#2E3440",
  nord1: "#3B4252",
  nord2: "#434C5E",
  nord3: "#4C566A",
  nord3b: "#616E88", // brightened nord3 (comments)
  // Snow Storm (light foregrounds)
  nord4: "#D8DEE9",
  nord5: "#E5E9F0",
  nord6: "#ECEFF4",
  // Frost (cool accents)
  nord7: "#8FBCBB",
  nord8: "#88C0D0",
  nord9: "#81A1C1",
  nord10: "#5E81AC",
  // Aurora (semantic / status)
  nord11: "#BF616A", // red
  nord12: "#D08770", // orange
  nord13: "#EBCB8B", // yellow
  nord14: "#A3BE8C", // green
  nord15: "#B48EAD", // purple / violet
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
  /** Accent used for recall/memory highlights */
  memory: string;
  codeBg: string;
  codeSpanBg: string;
};

export type TuiTheme = {
  name: string;
  syntaxTheme: string;
  dark: Palette;
  light: Palette;
};

// ─── Nord palettes ─────────────────────────────────────────────────────────

const c = NORD_COLORS;

const NORD_DARK: Palette = {
  user: c.nord14,
  assistant: c.nord8,
  thinking: c.nord15,
  tool: c.nord10,
  system: c.nord4,
  border: c.nord8,
  gutter: c.nord3,
  muted: c.nord4,
  faint: c.nord3b,
  warning: c.nord12,
  error: c.nord11,
  info: c.nord9,
  success: c.nord14,
  text: c.nord6,
  memory: c.nord15,
  codeBg: c.nord0,
  codeSpanBg: c.nord1,
};

const NORD_LIGHT: Palette = {
  user: c.nord14,
  assistant: c.nord10,
  thinking: c.nord15,
  tool: c.nord9,
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
};

export const NORD: TuiTheme = {
  name: "nord",
  syntaxTheme: "nord",
  dark: NORD_DARK,
  light: NORD_LIGHT,
};

export const ACTIVE_THEME: TuiTheme = NORD;
export const PALETTE: Palette = ACTIVE_THEME.dark;

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

/** Resolve a syntax-theme name to a cli-highlight Theme object or name string. */
export function resolveSyntaxTheme(name: string): HighlightTheme | string {
  return NAMED_SYNTAX_THEMES[name] ?? name;
}
