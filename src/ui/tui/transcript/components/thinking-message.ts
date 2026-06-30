import type { Component } from "@earendil-works/pi-tui";
import { TUI_STYLE } from "../../theme.js";
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
    const lineCount = this.text.split("\n").filter((l) => l.trim()).length;
    const header = lineCount > 1
      ? `\u25be thinking (${lineCount} lines)`
      : "\u25be thinking";
    const lines = wrapContent(
      `${header}\n${this.text.trim()}`,
      width,
      TUI_STYLE.thinking,
    );
    return renderAccentLines(
      lines,
      "thinking",
      "raised",
      false,
      width,
    );
  }
}
