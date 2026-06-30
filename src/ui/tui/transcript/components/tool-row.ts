import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { PALETTE, paintZoneLine } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { accentBar } from "../render-utils.js";

const BODY_PREVIEW_LINES = 16;

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
    const bg = this.opts.backgroundZones;
    const bar = accentBar("tool");
    const indent = "   ";
    const icon = chalk.hex(PALETTE.tool)(state.toolIcon);
    const label = chalk.hex(PALETTE.tool)(state.toolLabel);
    const lines: string[] = [];

    if (state.resultSummary === undefined) {
      const row = `${bar} ${icon}  ${label}  ${chalk.dim(state.toolPending)}`;
      lines.push(paintZoneLine(row, "raised", bg, width));
      return lines;
    }

    const summaryStyle = state.isError
      ? chalk.hex(PALETTE.error)
      : chalk.hex(PALETTE.success);
    const row = `${bar} ${icon}  ${label}  ${summaryStyle(state.resultSummary)}`;
    lines.push(paintZoneLine(row, "raised", bg, width));

    if (
      state.resultBody &&
      (state.isError || state.toolName === "shell")
    ) {
      const bodyWidth = Math.max(10, width - 6);
      const rawLines = state.resultBody.split("\n");
      const shown = rawLines.slice(0, BODY_PREVIEW_LINES);
      for (const l of shown) {
        for (const wl of wrapTextWithAnsi(chalk.dim(l), bodyWidth)) {
          lines.push(paintZoneLine(`${indent}${wl}`, "raised", bg, width));
        }
      }
      if (rawLines.length > BODY_PREVIEW_LINES) {
        const more = chalk.hex(PALETTE.faint)(
          `${indent}… +${rawLines.length - BODY_PREVIEW_LINES} more lines`,
        );
        lines.push(paintZoneLine(more, "raised", bg, width));
      }
    }

    return lines;
  }
}
