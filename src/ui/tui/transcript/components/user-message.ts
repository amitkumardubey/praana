import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { TUI_STYLE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { wrapContent } from "../render-utils.js";

/** User turn — dim left border with vertical padding. */
export class UserMessageComponent implements Component {
  constructor(
    private readonly text: string,
    private readonly opts: TranscriptRenderOpts,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const BORDER = "│";
    const hPad = 2;
    const lines = wrapContent(this.text, width - 1 - hPad, TUI_STYLE.user);

    const emptyLine = `${BORDER}${" ".repeat(width - 1)}`;

    return [
      "",
      emptyLine,
      ...lines.map((line) => {
        const padded = line + " ".repeat(Math.max(0, width - 1 - hPad - visibleWidth(line)));
        return `${BORDER} ${padded}`;
      }),
      emptyLine,
      "",
    ];
  }
}
