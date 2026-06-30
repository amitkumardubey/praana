/* Terminal-native semantic styling for the PRAANA pi-tui TUI. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

export function resolveSyntaxTheme(name: string): HighlightTheme | string {
  return name;
}
