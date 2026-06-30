import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { PALETTE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { renderAccentLines, wrapContent } from "../render-utils.js";

/** User turn — blue accent, raised zone (design §5). */
export class UserMessageComponent implements Component {
  constructor(
    private readonly text: string,
    private readonly opts: TranscriptRenderOpts,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines = wrapContent(
      `› ${this.text}`,
      width,
      (s) => chalk.hex(PALETTE.user)(s),
    );
    return renderAccentLines(
      lines,
      "user",
      "raised",
      this.opts.backgroundZones,
      width,
    );
  }
}
