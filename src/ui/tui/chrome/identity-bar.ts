/**
 * One-line top identity bar: brand mark, version, active model.
 *
 * Renders as a single line. The caller is expected to drive a re-render
 * (via tui.requestRender()) after mutating the bar (e.g. on setModel).
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { PALETTE } from "../theme.js";

/** Top-of-screen brand bar. Brand violet + dim version + cyan model. */
export class IdentityBar implements Component {
  private model: string;
  private version: string;

  constructor(model: string, version: string) {
    this.model = model;
    this.version = version;
  }

  /** Replace the active model label. Caller triggers tui.requestRender(). */
  setModel(model: string): void {
    this.model = model;
  }

  invalidate(): void {
    // Stateless: nothing to drop. Render is derived from current fields.
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    const line = [
      chalk.hex(PALETTE.memory)("praana"),
      chalk.dim(`v${this.version}`),
      chalk.hex(PALETTE.assistant)(this.model),
    ].join("  ");
    return [truncateToWidth(line, width, "…")];
  }
}
