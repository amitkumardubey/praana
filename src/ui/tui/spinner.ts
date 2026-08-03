/**
 * OpenTUI-native animated spinner, replacing pi-tui's `Loader`.
 */
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner extends BoxRenderable {
  private readonly textNode: TextRenderable;
  private frame = 0;
  private readonly interval: ReturnType<typeof setInterval>;

  constructor(ctx: RenderContext, label: string) {
    super(ctx, { id: "spinner", flexDirection: "row" });
    this.textNode = new TextRenderable(ctx, {
      content: TUI_STYLE.muted(`${FRAMES[0]} ${label}`),
    });
    this.add(this.textNode);
    this.interval = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.textNode.content = TUI_STYLE.muted(`${FRAMES[this.frame]} ${label}`);
      this.ctx.requestRender();
    }, 80);
  }

  stop(): void {
    clearInterval(this.interval);
  }
}