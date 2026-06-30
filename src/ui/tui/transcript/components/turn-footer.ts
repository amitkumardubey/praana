import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { renderAccentLines } from "../render-utils.js";

/** Dim per-turn digest line. */
export class TurnFooterComponent implements Component {
  constructor(private readonly text: string) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderAccentLines(
      [chalk.dim(this.text)],
      "turn_footer",
      "canvas",
      false,
      width,
    );
  }
}
