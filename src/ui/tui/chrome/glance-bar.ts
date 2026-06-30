/**
 * Bottom glance chrome — ctx%, tiers, skills, cost, flags (design §5).
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { StatusBarInput } from "../../../status-bar.js";
import { formatTuiGlanceLine } from "./glance-format.js";
import { paintZoneLine } from "../theme.js";

export interface GlanceBarInput {
  status: StatusBarInput;
  showCost: boolean;
  sessionInputTokens: number;
  sessionOutputTokens: number;
}

export class GlanceBar implements Component {
  private input: GlanceBarInput | null = null;
  private backgroundZones = true;
  private readonly tui: TUI;

  constructor(tui: TUI) {
    this.tui = tui;
  }

  update(input: GlanceBarInput): void {
    this.input = input;
    this.tui.requestRender();
  }

  setBackgroundZones(enabled: boolean): void {
    this.backgroundZones = enabled;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [""];
    const line = this.input
      ? formatTuiGlanceLine(this.input.status, {
          showCost: this.input.showCost,
          sessionInputTokens: this.input.sessionInputTokens,
          sessionOutputTokens: this.input.sessionOutputTokens,
        })
      : chalk.dim("initializing…");
    const painted = paintZoneLine(
      truncateToWidth(line, width, "…"),
      "chrome",
      this.backgroundZones,
      width,
    );
    return [painted];
  }
}
