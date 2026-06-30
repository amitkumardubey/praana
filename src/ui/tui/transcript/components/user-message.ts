import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { PALETTE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { wrapContent } from "../render-utils.js";

/** User turn — dim neutral-gray background (always on). */
export class UserMessageComponent implements Component {
  constructor(
    private readonly text: string,
    private readonly opts: TranscriptRenderOpts,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines = wrapContent(
      ` › ${this.text}`,
      width,
      (s) => chalk.hex(PALETTE.user)(s),
    );
    const blankLine = chalk.bgHex(PALETTE.userBg)(" ".repeat(width));
    return [
      blankLine,
      ...lines.map((line) => {
        const truncated = truncateToWidth(line, width, "…", false);
        const actual = visibleWidth(truncated);
        const padding = " ".repeat(Math.max(0, width - actual));
        return chalk.bgHex(PALETTE.userBg)(truncated + padding);
      }),
      blankLine,
    ];
  }
}
