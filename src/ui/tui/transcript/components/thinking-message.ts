import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { PALETTE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { renderAccentLines, wrapContent } from "../render-utils.js";

/** Collapsible thinking block — only materialised when /thinking on. */
export class ThinkingMessageComponent implements Component {
  private text: string;

  constructor(initialText: string, private readonly opts: TranscriptRenderOpts) {
    this.text = initialText;
  }

  appendDelta(delta: string): void {
    this.text += delta;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const preview =
      this.text.length > 120 ? this.text.slice(0, 117) + "…" : this.text;
    const lines = wrapContent(
      `▾ thinking · ${preview}`,
      width,
      (s) => chalk.dim.italic.hex(PALETTE.thinking)(s),
    );
    return renderAccentLines(
      lines,
      "thinking",
      "raised",
      this.opts.backgroundZones,
      width,
    );
  }
}
