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
    const preview = smartTruncate(this.text, 100);
    const header = lineCount > 1
      ? `\u25be thinking (${lineCount} lines) \xb7 ${preview}`
      : `\u25be thinking \xb7 ${preview}`;
    const lines = wrapContent(
      header,
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

/** Truncate at the last sentence or word boundary before maxLen. */
function smartTruncate(text: string, maxLen: number): string {
  // Grab only the first meaningful line for the preview.
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  if (firstLine.length <= maxLen) return firstLine.trim();
  // Try to break at sentence end (. ! ?).
  const sentenceEnd = firstLine.slice(0, maxLen).search(/[.!?][^.!?]*$/);
  if (sentenceEnd > maxLen * 0.5) {
    return firstLine.slice(0, sentenceEnd + 1).trim() + "…";
  }
  // Fall back to last word boundary.
  const lastSpace = firstLine.slice(0, maxLen).lastIndexOf(" ");
  const cut = lastSpace > maxLen * 0.5 ? lastSpace : maxLen;
  return firstLine.slice(0, cut).trim() + "…";
}
