/* Boot banner for the PRAANA pi-tui TUI.
 *
 * Owns the PRAANA wordmark (the 6-line box-drawing ASCII art from design
 * §5.1) and the boot summary panel. The wordmark is rendered with chalk's
 * truecolor hex when the terminal supports colour (NO_COLOR off and
 * chalk.level >= 1); otherwise it falls back to mono. Width-gated: when
 * the terminal is narrower than the art, the wordmark is suppressed and
 * only the summary block prints.
 */
import chalk from "chalk";
import { NORD_COLORS } from "./theme.js";

/** PRAANA wordmark — 6 lines of box-drawing ASCII art (design §5.1). */
export const PRAANA_WORDMARK: string[] = [
  " ██████╗ ██████╗  █████╗  █████╗ ███╗   ██╗ █████╗",
  " ██╔══██╗██╔══██╗██╔══██╗██╔══██╗████╗  ██║██╔══██╗",
  " ██████╔╝██████╔╝███████║███████║██╔██╗ ██║███████║",
  " ██╔═══╝ ██╔══██╗██╔══██║██╔══██║██║╚██╗██║██╔══██║",
  " ██║     ██║  ██║██║  ██║██║  ██║██║ ╚████║██║  ██║",
  " ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝",
];

/** Visible column width of the widest wordmark line (all glyphs are single-column). */
export const PRAANA_WORDMARK_WIDTH: number = PRAANA_WORDMARK.reduce(
  (max, line) => Math.max(max, line.length),
  0,
);

export interface BootBannerOpts {
  /** Package version, printed after the wordmark. */
  version: string;
  /** Pre-formatted summary line from `formatTuiBootSummary`. */
  summary: string;
  /** When true, prefix the summary with `resumed ·` (resume-from-disk). */
  isResume: boolean;
  /** Terminal width in columns. Art is suppressed below the wordmark width. */
  width: number;
  /** When true, skip ANSI colour (NO_COLOR). */
  noColor?: boolean;
  /** `[ui] banner` config; defaults to true when undefined. */
  banner?: boolean;
}

/**
 * Render the boot banner as a list of lines, ready to print before the TUI
 * starts. The leading blank line provides top padding in the no-art case
 * and acts as a separator between the art and the summary block otherwise.
 */
export function renderBootBanner(opts: BootBannerOpts): string[] {
  const showArt =
    (opts.banner ?? true) && opts.width >= PRAANA_WORDMARK_WIDTH;
  const useColor = !opts.noColor && chalk.level >= 1;
  const violet = NORD_COLORS.nord15;

  const lines: string[] = [];

  if (showArt) {
    for (const line of PRAANA_WORDMARK) {
      lines.push(useColor ? chalk.hex(violet)(line) : line);
    }
  }

  lines.push("");
  lines.push(`  praana v${opts.version}`);
  lines.push(opts.isResume ? `  resumed · ${opts.summary}` : `  ${opts.summary}`);
  lines.push("");

  return lines;
}
