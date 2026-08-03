/* Terminal-native semantic styling for the PRAANA OpenTUI-based TUI.
 * OpenTUI's native renderer handles ANSI-aware width math internally;
 * the small helpers below are retained only for the single chrome-bar
 * `paintZoneLine` pad/truncate contract used by identity-bar.ts / glance-bar.ts. */
import chalk from "chalk";
import type { Theme as HighlightTheme } from "cli-highlight";

export type TextStyle = (text: string) => string;

const plain: TextStyle = (text) => text;

/**
 * Semantic TUI styles that defer the main palette to the user's terminal.
 * Only exceptional states use standard ANSI colors.
 */
export const TUI_STYLE = {
  text: plain,
  user: plain,
  assistant: plain,
  system: chalk.dim,
  muted: chalk.dim,
  faint: chalk.dim,
  heading: chalk.bold,
  thinking: (text: string) => chalk.dim.italic(text),
  tool: chalk.yellow,
  info: chalk.cyan,
  memory: chalk.magenta,
  warning: chalk.yellow,
  error: chalk.red,
  success: chalk.green,
  border: chalk.dim,
} as const satisfies Record<string, TextStyle>;

export const EDITOR_BORDER_STYLE: TextStyle = () => "";

// ─── Elevation zones (design §9) ───────────────────────────────────────────

export type ZoneKind = "chrome" | "raised" | "canvas";

export function zonesEnabled(configOn: boolean): boolean {
  return configOn && !process.env.NO_COLOR && chalk.level >= 1;
}

export function zoneBg(
  kind: ZoneKind,
  enabled: boolean,
): ((text: string) => string) | undefined {
  void kind;
  void enabled;
  return undefined;
}

/** Strip ANSI escape codes (SGR sequences) for visible-width math on styled text. */
export function stripAnsiEscapes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible (non-ANSI) length of a string. */
export function visibleTextWidth(text: string): number {
  return stripAnsiEscapes(text).length;
}

/** Truncate plain (unstyled) text to `width` visible characters. */
export function truncatePlainText(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return text.slice(0, 1);
  return text.slice(0, width - 1) + "…";
}

export function paintZoneLine(
  line: string,
  kind: ZoneKind,
  enabled: boolean,
  width: number,
): string {
  const bg = zoneBg(kind, enabled);
  const truncated = truncatePlainText(line, width);
  if (!bg) return truncated;
  const actual = visibleTextWidth(truncated);
  const padding = " ".repeat(Math.max(0, width - actual));
  return bg(truncated + padding);
}

export function resolveSyntaxTheme(name: string): HighlightTheme | string {
  return name;
}
