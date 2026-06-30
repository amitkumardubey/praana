import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { PALETTE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { renderAccentLines, wrapContent } from "../render-utils.js";

/** Slash-command output and system notices. */
export class SystemLineComponent implements Component {
  constructor(
    private readonly text: string,
    private readonly opts: TranscriptRenderOpts,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines = wrapContent(this.text, width, (s) =>
      chalk.hex(PALETTE.system)(s),
    );
    return renderAccentLines(
      lines,
      "system",
      "raised",
      this.opts.backgroundZones,
      width,
    );
  }
}
