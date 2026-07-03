import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TUI_STYLE } from "./theme.js";
import { wrapContent } from "./transcript/render-utils.js";

const TITLE = " slash command result ";
const FOOTER = " Press Enter or Esc to close ";

/** Centered overlay that displays slash-command output above the transcript. */
export class SlashCommandResultOverlay implements Component {
  private lines: string[] = [];

  setLines(lines: string[]): void {
    this.lines = lines;
  }

  getLines(): string[] {
    return this.lines;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const borderColor = TUI_STYLE.info;
    const insideWidth = Math.max(10, width - 2);
    const bodyWidth = Math.max(8, width - 4);

    const top = borderColor(`╭${this.buildTitleLine(insideWidth)}╮`);
    const bottom = borderColor(`╰${this.buildFooterLine(insideWidth)}╯`);

    const result: string[] = [top];
    result.push(this.emptyLine(insideWidth));

    if (this.lines.length === 0) {
      result.push(this.emptyLine(insideWidth));
    } else {
      for (const line of this.lines) {
        const wrapped = wrapContent(line, width, TUI_STYLE.text);
        for (const wl of wrapped) {
          const visible = visibleWidth(wl);
          const pad = " ".repeat(Math.max(0, bodyWidth - visible));
          result.push(
            borderColor("│") + " " + wl + pad + " " + borderColor("│"),
          );
        }
      }
    }

    result.push(this.emptyLine(insideWidth));
    result.push(this.footerLine(insideWidth));
    result.push(bottom);

    return result;
  }

  private emptyLine(insideWidth: number): string {
    return TUI_STYLE.info("│") + " ".repeat(insideWidth) + TUI_STYLE.info("│");
  }

  private footerLine(insideWidth: number): string {
    const bodyWidth = insideWidth - 2;
    const footerVisible = visibleWidth(FOOTER);
    const pad = " ".repeat(Math.max(0, bodyWidth - footerVisible));
    return (
      TUI_STYLE.info("│") +
      " " +
      TUI_STYLE.muted(FOOTER) +
      pad +
      " " +
      TUI_STYLE.info("│")
    );
  }

  private buildTitleLine(insideWidth: number): string {
    const titleVisible = visibleWidth(TITLE);
    if (titleVisible >= insideWidth) {
      return "─".repeat(insideWidth);
    }
    const remainder = insideWidth - titleVisible;
    return TITLE + "─".repeat(remainder);
  }

  private buildFooterLine(insideWidth: number): string {
    const footerVisible = visibleWidth(FOOTER);
    if (footerVisible >= insideWidth) {
      return "─".repeat(insideWidth);
    }
    const remainder = insideWidth - footerVisible;
    return "─".repeat(remainder) + FOOTER;
  }
}
