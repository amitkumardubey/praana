import {
  BoxRenderable,
  MarkdownRenderable,
  TextRenderable,
  type RenderContext,
  type SyntaxStyle,
} from "@opentui/core";
import { TUI_STYLE } from "../../theme.js";
import { buildMarkdownSyntaxStyle } from "../markdown-theme.js";
import type { TranscriptRenderOpts } from "../opts.js";

export class AssistantMessageComponent extends BoxRenderable {
  private readonly opts: TranscriptRenderOpts;
  private readonly syntaxStyle: SyntaxStyle;
  private readonly markdownNode: MarkdownRenderable;
  private readonly plainNode: TextRenderable;
  private text: string;

  constructor(ctx: RenderContext, text: string, opts: TranscriptRenderOpts) {
    super(ctx, {
      id: "assistant-message",
      flexDirection: "column",
      flexGrow: 1,
    });
    this.text = text;
    this.opts = opts;
    this.syntaxStyle = buildMarkdownSyntaxStyle(opts.syntaxTheme);
    this.markdownNode = new MarkdownRenderable(ctx, {
      content: text,
      syntaxStyle: this.syntaxStyle,
      flexGrow: 1,
    });
    this.plainNode = new TextRenderable(ctx, { content: TUI_STYLE.text(text), flexGrow: 1 });
    this.add(this.opts.markdownRendering ? this.markdownNode : this.plainNode);
    this.syncVisibility();
  }

  appendDelta(delta: string): void {
    this.text += delta;
    if (this.opts.markdownRendering) {
      this.markdownNode.content = this.text;
      this.markdownNode.streaming = true;
    } else {
      this.plainNode.content = TUI_STYLE.text(this.text);
    }
  }

  setText(text: string): void {
    this.text = text;
    if (this.opts.markdownRendering) {
      this.markdownNode.content = text;
      this.markdownNode.streaming = false;
    } else {
      this.plainNode.content = TUI_STYLE.text(text);
    }
  }

  getText(): string {
    return this.text;
  }

  private syncVisibility(): void {
    const useMd = this.opts.markdownRendering;
    this.markdownNode.visible = useMd;
    this.plainNode.visible = !useMd;
  }
}
