import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";

/** Collapsible thinking block — only materialised when /thinking on. */
export class ThinkingMessageComponent extends BoxRenderable {
  private readonly opts: TranscriptRenderOpts;
  private readonly textNode: TextRenderable;
  private text: string;
  private expanded: boolean;
  private displayedLines: number;

  constructor(ctx: RenderContext, text: string, opts: TranscriptRenderOpts) {
    super(ctx, { id: "thinking-message", flexDirection: "column" });
    this.text = text;
    this.opts = opts;
    this.expanded = true;
    this.displayedLines = Infinity;
    this.textNode = new TextRenderable(ctx, { content: "" });
    this.add(this.textNode);
    this.repaint();
  }

  appendDelta(delta: string): void {
    this.text += delta;
    this.repaint();
  }

  setText(text: string): void {
    this.text = text;
    this.repaint();
  }

  getText(): string {
    return this.text;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.repaint();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  setDisplayedLines(lines: number): void {
    this.displayedLines = lines;
    this.repaint();
  }

  private repaint(): void {
    this.textNode.content = TUI_STYLE.thinking(this.paintBody());
  }

  private paintBody(): string {
    void this.opts;
    const rawLines = this.text.split("\n");
    const visibleLines = this.expanded ? rawLines : rawLines.slice(0, this.displayedLines);
    const lineCount = rawLines.filter((l) => l.trim()).length;
    const header: string = this.expanded
      ? lineCount > 1
        ? `\u25be thinking (${lineCount} lines)`
        : "\u25be thinking"
      : `\u25be thinking ${lineCount} lines (collapsed)`;
    return `${header}\n${visibleLines.join("\n").trim()}`;
  }
}
