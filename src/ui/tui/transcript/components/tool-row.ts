import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { TUI_STYLE, paintZoneLine } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";

const BODY_PREVIEW_LINES = 24;

export interface ToolRowState {
  toolName: string;
  toolIcon: string;
  toolLabel: string;
  toolPending: string;
  resultSummary?: string;
  resultBody?: string | null;
  isError?: boolean;
}

/** Inline tool row — updated in place when result arrives. */
export class ToolRowComponent implements Component {
  private state: ToolRowState;

  constructor(
    state: ToolRowState,
    private readonly opts: TranscriptRenderOpts,
  ) {
    this.state = { ...state };
  }

  get toolName(): string {
    return this.state.toolName;
  }

  hasResult(): boolean {
    return this.state.resultSummary !== undefined;
  }

  setResult(patch: Partial<ToolRowState>): void {
    this.state = { ...this.state, ...patch };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { state } = this;
    const bg = false;
    const indent = "    ";
    const icon = TUI_STYLE.faint(state.toolIcon);
    const label = TUI_STYLE.muted(state.toolLabel);
    const lines: string[] = [];

    if (state.resultSummary === undefined) {
      const row = `  ${icon} ${label} ${chalk.dim(state.toolPending)}`;
      lines.push(paintZoneLine(row, "raised", bg, width));
      return lines;
    }

    const summaryStyle = state.isError
      ? TUI_STYLE.error
      : TUI_STYLE.success;
    const row = `  ${icon} ${label} ${summaryStyle(state.resultSummary)}`;
    lines.push(paintZoneLine(row, "raised", bg, width));

    if (
      state.resultBody &&
      (state.isError || state.toolName === "shell")
    ) {
      const bodyWidth = Math.max(10, width - 7);
      const rawLines = state.resultBody.split("\n");
      const shown = rawLines.slice(0, BODY_PREVIEW_LINES);
      for (const l of shown) {
        for (const wl of wrapTextWithAnsi(chalk.dim(l), bodyWidth)) {
          lines.push(paintZoneLine(`${indent}${wl}`, "raised", bg, width));
        }
      }
      if (rawLines.length > BODY_PREVIEW_LINES) {
        const more = TUI_STYLE.faint(
          `${indent}… +${rawLines.length - BODY_PREVIEW_LINES} more lines`,
        );
        lines.push(paintZoneLine(more, "raised", bg, width));
      }
    }

    return lines;
  }
}
