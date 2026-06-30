import { Markdown, type Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { PALETTE } from "../../theme.js";
import { buildMarkdownTheme } from "../markdown-theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { wrapContent } from "../render-utils.js";

/** Streaming assistant prose — canvas zone. */
export class AssistantMessageComponent implements Component {
  private text: string;
  private readonly markdownTheme;

  constructor(
    initialText: string,
    private readonly opts: TranscriptRenderOpts,
  ) {
    this.text = initialText;
    this.markdownTheme = buildMarkdownTheme(opts.syntaxTheme);
  }

  appendDelta(delta: string): void {
    this.text += delta;
  }

  getText(): string {
    return this.text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const contentWidth = Math.max(10, width - 4);
    let lines: string[];
    if (this.opts.markdownRendering) {
      const md = new Markdown(this.text, 0, 0, this.markdownTheme, {
        color: chalk.hex(PALETTE.text),
      });
      lines = md.render(contentWidth);
    } else {
      lines = wrapContent(this.text, width, (s) => chalk.hex(PALETTE.text)(s));
    }
    return lines;
  }
}
