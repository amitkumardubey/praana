import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import chalk from "chalk";
import { TUI_STYLE, paintZoneLine, type ZoneKind } from "../../theme.js";
import { wrapContent } from "../render-utils.js";
import type { TranscriptRenderOpts } from "../opts.js";

export interface ToolRowState {
  toolName: string;
  toolIcon: string;
  toolLabel: string;
  toolPending: string;
  resultSummary?: string;
  resultBody?: string | null;
  isError?: boolean;
  expandable?: boolean;
  expanded?: boolean;
}

const BODY_PREVIEW_LINES = 24;

/** Inline tool row — updated in place when result arrives. */
export class ToolRowComponent extends BoxRenderable {
  private readonly opts: TranscriptRenderOpts;
  private state: ToolRowState;
  private readonly headerNode: TextRenderable;
  private readonly bodyNode: TextRenderable;

  constructor(ctx: RenderContext, state: ToolRowState, opts: TranscriptRenderOpts) {
    super(ctx, { id: "tool-row", flexDirection: "column" });
    this.state = { ...state };
    this.opts = opts;
    this.headerNode = new TextRenderable(ctx, { content: this.paintHeader() });
    this.bodyNode = new TextRenderable(ctx, { content: "" });
    this.add(this.headerNode);
    this.add(this.bodyNode);
  }

  get toolName(): string {
    return this.state.toolName;
  }

  hasResult(): boolean {
    return this.state.resultSummary !== undefined;
  }

  setResult(patch: Partial<ToolRowState>): void {
    this.state = { ...this.state, ...patch };
    this.headerNode.content = this.paintHeader();
    this.bodyNode.content = this.paintBody();
  }

  getResultSummary(): string | undefined {
    return this.state.resultSummary;
  }

  getResultBody(): string | null | undefined {
    return this.state.resultBody;
  }

  getIsError(): boolean | undefined {
    return this.state.isError;
  }

  isExpanded(): boolean {
    return this.state.expanded ?? false;
  }

  setExpanded(expanded: boolean): void {
    this.state = { ...this.state, expanded };
    this.bodyNode.content = this.paintBody();
  }

  private paintHeader(): string {
    const icon = TUI_STYLE.faint(this.state.toolIcon);
    const label = TUI_STYLE.muted(this.state.toolLabel);
    const width = this.width || 80;
    if (this.state.resultSummary === undefined) {
      const row = `  ${icon} ${label} ${chalk.dim(this.state.toolPending)}`;
      return paintZoneLine(row, "raised" as ZoneKind, false, width);
    }
    const summaryStyle = this.state.isError ? TUI_STYLE.error : TUI_STYLE.success;
    const row = `  ${icon} ${label} ${summaryStyle(this.state.resultSummary)}`;
    return paintZoneLine(row, "raised" as ZoneKind, false, width);
  }

  private paintBody(): string {
    const { state } = this;
    const width = this.width || 80;
    if (!state.resultBody || (!state.expanded && !state.isError && state.toolName !== "shell")) {
      return "";
    }
    const bodyWidth = Math.max(10, width - 7);
    const indent = "    ";
    const rawLines = state.resultBody.split("\n");
    const shown = rawLines.slice(0, BODY_PREVIEW_LINES);
    const lines: string[] = [];
    for (const l of shown) {
      for (const wl of wrapContent(chalk.dim(l), bodyWidth)) {
        lines.push(paintZoneLine(`${indent}${wl}`, "raised" as ZoneKind, false, width));
      }
    }
    if (rawLines.length > BODY_PREVIEW_LINES) {
      lines.push(
        paintZoneLine(
          TUI_STYLE.faint(`${indent}… +${rawLines.length - BODY_PREVIEW_LINES} more lines`),
          "raised" as ZoneKind,
          false,
          width,
        ),
      );
    }
    return lines.join("\n");
  }
}
