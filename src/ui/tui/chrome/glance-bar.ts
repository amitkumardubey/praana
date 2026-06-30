/**
 * One-line bottom glance bar: surfaces model, ctx, repo, mode, memory, skills.
 *
 * Renders the same content as the readline `formatStatusLine` helper so the
 * bottom strip stays consistent with the legacy readline UI. The bar is
 * stateless w.r.t. caching — it derives lines from the current input on
 * every render. `update` triggers a re-render via `tui.requestRender()`.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { StatusBarInput } from "../../../status-bar.js";
import { formatStatusLine } from "../../../status-bar.js";

/** Bottom-of-screen glance strip. Falls back to a dim placeholder pre-resolve. */
export class GlanceBar implements Component {
  private input: StatusBarInput | null;
  private tui: TUI;

  constructor(tui: TUI) {
    this.tui = tui;
    this.input = null;
  }

  /** Replace the rendered status and request a re-render. */
  update(input: StatusBarInput): void {
    this.input = input;
    this.tui.requestRender();
  }

  invalidate(): void {
    // Stateless: nothing to drop. Render is derived from current input.
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    const line = this.input
      ? formatStatusLine(this.input)
      : chalk.dim("initializing…");
    return [truncateToWidth(line, width, "…")];
  }
}
