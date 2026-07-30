import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { paintZoneLine } from "../../theme.js";

/** Dim per-turn digest line — no accent bar, no top/bottom padding. */
export class TurnFooterComponent implements Component {
  constructor(private text: string) {}

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [paintZoneLine(`   ${chalk.dim(this.text)}`, "canvas", false, width)];
  }
}
