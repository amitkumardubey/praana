/**
 * Top identity chrome — brand, model, cwd · branch (design §5).
 */
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import type { StatusBarInput } from "../../../status-bar.js";
import { formatTuiIdentityLine } from "./glance-format.js";
import { paintZoneLine, truncatePlainText, type ZoneKind } from "../theme.js";

export class IdentityBar extends BoxRenderable {
  private readonly textNode: TextRenderable;
  private input: StatusBarInput | null = null;
  private backgroundZones = true;

  constructor(ctx: RenderContext) {
    super(ctx, { id: "identity-bar", flexDirection: "row" });
    this.textNode = new TextRenderable(ctx, { id: "identity-bar-text", content: " praana" });
    this.add(this.textNode);
  }

  setInput(input: StatusBarInput): void {
    this.input = input;
    this.repaint();
  }

  setBackgroundZones(enabled: boolean): void {
    this.backgroundZones = enabled;
    this.repaint();
  }

  private repaint(): void {
    const width = this.width || 80;
    const line = this.input ? formatTuiIdentityLine(this.input) : "praana";
    this.textNode.content = paintZoneLine(
      truncatePlainText(" " + line, width),
      "chrome" satisfies ZoneKind,
      this.backgroundZones,
      width,
    );
  }

  protected onResize(_width: number, _height: number): void {
    this.repaint();
  }
}
