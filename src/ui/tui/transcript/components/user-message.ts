import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";

export class UserMessageComponent extends BoxRenderable {
  private readonly opts: TranscriptRenderOpts;
  private readonly textNode: TextRenderable;
  private text: string;

  constructor(ctx: RenderContext, text: string, opts: TranscriptRenderOpts) {
    super(ctx, { id: "user-message", flexDirection: "column" });
    this.text = text;
    this.opts = opts;
    this.textNode = new TextRenderable(ctx, { content: this.paint() });
    this.add(this.textNode);
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
    this.textNode.content = this.paint();
  }

  private paint(): string {
    return TUI_STYLE.user(this.text);
  }
}
