import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import chalk from "chalk";
import { paintZoneLine, type ZoneKind } from "../../theme.js";

/** Dim per-turn digest line — no accent bar, no top/bottom padding. */
export class TurnFooterComponent extends BoxRenderable {
  private readonly textNode: TextRenderable;
  private text: string;

  constructor(ctx: RenderContext, text: string) {
    super(ctx, { id: "turn-footer", flexDirection: "row" });
    this.text = text;
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
    const width = this.width || 80;
    return paintZoneLine(`   ${chalk.dim(this.text)}`, "canvas" satisfies ZoneKind, false, width);
  }
}
