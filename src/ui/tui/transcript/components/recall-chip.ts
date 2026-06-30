import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { PALETTE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { renderAccentLines } from "../render-utils.js";

/** Violet memory recall chip (design §4). */
export class RecallChipComponent implements Component {
  constructor(
    private readonly preview: string,
    private readonly count: number,
    private readonly opts: TranscriptRenderOpts,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const chip =
      chalk.hex(PALETTE.memory)(`◆ recall ${this.count}`) +
      chalk.hex(PALETTE.faint)(`  "${this.preview}"`);
    return renderAccentLines(
      [chip],
      "recall",
      "raised",
      this.opts.backgroundZones,
      width,
    );
  }
}
