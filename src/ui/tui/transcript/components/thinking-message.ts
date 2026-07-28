import type { Component } from "@earendil-works/pi-tui";
import { TUI_STYLE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { renderAccentLines, wrapContent } from "../render-utils.js";

/** Collapsible thinking block — only materialised when /thinking on. */
export class ThinkingMessageComponent implements Component {
  private text: string;
  private expanded: boolean;
  private displayedLines: number;

  constructor(initialText: string, private readonly opts: TranscriptRenderOpts) {
    this.text = initialText;
    this.expanded = true;
    this.displayedLines = Infinity;
  }

  appendDelta(delta: string): void {
    this.text += delta;
  }

  setText(text: string): void {
    this.text = text;
  }

  getText(): string {
    return this.text;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  setDisplayedLines(lines: number): void {
    this.displayedLines = lines;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const rawLines = this.text.split("\n");
    const visibleLines = this.expanded
      ? rawLines
      : rawLines.slice(0, this.displayedLines);
    const lineCount = rawLines.filter((l) => l.trim()).length;
    const header = this.expanded
      ? lineCount > 1
        ? `\u25be thinking (${lineCount} lines)`
        : "\u25be thinking"
      : `\u25be thinking ${lineCount} lines (collapsed)`;
    const lines = wrapContent(
      `${header}\n${visibleLines.join("\n").trim()}`,
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
