import type { Component } from "@earendil-works/pi-tui";
import { TUI_STYLE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { renderAccentLines } from "../render-utils.js";

/** Violet memory recall chip (design §4). */
export class RecallChipComponent implements Component {
  constructor(
    private readonly preview: string,
    private readonly count: number,
    private readonly query: string | null,
    private readonly opts: TranscriptRenderOpts,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const label = TUI_STYLE.memory(`◆ recall ${this.count}`);
    const queryPart = this.query
      ? TUI_STYLE.faint(` · "${this.query.slice(0, 40)}"`)
      : "";
    const previewPart = this.preview
      ? TUI_STYLE.faint(` → "${this.preview.slice(0, 48)}"`)
      : "";
    const chip = label + queryPart + previewPart;
    return renderAccentLines(
      [chip],
      "recall",
      "raised",
      false,
      width,
    );
  }
}
