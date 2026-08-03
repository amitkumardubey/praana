import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";

function detectIcon(text: string): { icon: string; color: (s: string) => string } {
  const t = text.toLowerCase();
  if (/^(error|\[error\]|\u2715|fail|exception|crash)/.test(t) || /\berror\b/.test(t)) {
    return { icon: "\u2715 ", color: TUI_STYLE.error };
  }
  if (/^(warn|\[warn\]|warning|\u25b2)/.test(t)) {
    return { icon: "\u25b2 ", color: TUI_STYLE.warning };
  }
  if (/^(\u2713|ok |done|success|saved|completed|resumed)/.test(t)) {
    return { icon: "\u2713 ", color: TUI_STYLE.success };
  }
  if (/^(\u26a1|aborted|interrupted)/.test(t)) {
    return { icon: "\u26a1 ", color: TUI_STYLE.warning };
  }
  return { icon: "\xb7 ", color: TUI_STYLE.system };
}

/** Slash-command output and system notices. */
export class SystemLineComponent extends BoxRenderable {
  private readonly opts: TranscriptRenderOpts;
  private readonly textNode: TextRenderable;
  private text: string;

  constructor(ctx: RenderContext, text: string, opts: TranscriptRenderOpts) {
    super(ctx, { id: "system-line", flexDirection: "column" });
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
    const { icon, color } = detectIcon(this.text);
    return color(icon + this.text);
  }
}
