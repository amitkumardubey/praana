/**
 * Bottom glance chrome — ctx%, tiers, skills, cost, flags (design §5).
 */
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import chalk from "chalk";
import type { StatusBarInput } from "../../../status-bar.js";
import { formatTuiGlanceLine } from "./glance-format.js";
import { paintZoneLine, truncatePlainText } from "../theme.js";

export interface GlanceBarInput {
  status: StatusBarInput;
  showCost: boolean;
}

export class GlanceBar extends BoxRenderable {
  private readonly textNode: TextRenderable;
  private input: GlanceBarInput | null = null;
  private backgroundZones = true;

  constructor(ctx: RenderContext) {
    super(ctx, { id: "glance-bar", flexDirection: "row" });
    this.textNode = new TextRenderable(ctx, { id: "glance-bar-text", content: " initializing…" });
    this.add(this.textNode);
  }

  update(input: GlanceBarInput): void {
    this.input = input;
    this.repaint();
    (this as unknown as { requestRender: () => void }).requestRender();
  }

  setBackgroundZones(enabled: boolean): void {
    this.backgroundZones = enabled;
    this.repaint();
  }

  private repaint(): void {
    const width = this.width || 80;
    const line = this.input
      ? formatTuiGlanceLine(this.input.status, {
          showCost: this.input.showCost,
        })
      : chalk.dim("initializing…");
    this.textNode.content = paintZoneLine(
      truncatePlainText(" " + line, width),
      "chrome",
      this.backgroundZones,
      width,
    );
  }

  protected onResize(_width: number, _height: number): void {
    this.repaint();
  }
}
