import type { Component } from "@earendil-works/pi-tui";
import { TUI_STYLE, paintZoneLine } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { wrapContent } from "../render-utils.js";

/** User turn — terminal-native text with no forced background. */
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
      TUI_STYLE.user,
    );
    return ["", ...lines.map((line) => paintZoneLine(line, "raised", false, width)), ""];
  }
}
