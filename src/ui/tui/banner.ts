/* Boot banner — figlet Standard wordmark (design §5.1). */
import chalk from "chalk";
import { TUI_STYLE } from "./theme.js";

/** Figlet "Standard" rendering of "praana" from the ambient design spec. */
export const PRAANA_WORDMARK: string[] = [
  "  _ __  _ __ __ _  __ _ _ __   __ _",
  " | '_ \\| '__/ _` |/ _` | '_ \\ / _` |",
  " | |_) | | | (_| | (_| | | | | (_| |",
  " | .__/|_|  \\__,_|\\__,_|_| |_|\\__,_|",
  " |_|",
];

export const PRAANA_WORDMARK_WIDTH: number = PRAANA_WORDMARK.reduce(
  (max, line) => Math.max(max, line.length),
  0,
);

export interface BootBannerOpts {
  version: string;
  summaryLines: string[];
  width: number;
  noColor?: boolean;
  banner?: boolean;
}

export function renderBootBanner(opts: BootBannerOpts): string[] {
  const showArt =
    (opts.banner ?? true) && opts.width >= PRAANA_WORDMARK_WIDTH;
  const useColor = !opts.noColor && chalk.level >= 1;

  const lines: string[] = [""];

  if (showArt) {
    for (const line of PRAANA_WORDMARK) {
      lines.push(useColor ? TUI_STYLE.heading(line) : line);
    }
    lines.push("");
  }

  lines.push(useColor ? chalk.dim(`  v${opts.version}`) : `  v${opts.version}`);
  lines.push("");

  for (const summaryLine of opts.summaryLines) {
    lines.push(`  ${summaryLine}`);
  }

  lines.push("");
  return lines;
}
