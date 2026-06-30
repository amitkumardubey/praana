import type { Component } from "@earendil-works/pi-tui";
import { TUI_STYLE } from "../../theme.js";
import type { TranscriptRenderOpts } from "../opts.js";
import { renderAccentLines, wrapContent } from "../render-utils.js";

/** Detect a tone prefix icon from the text content. */
function detectIcon(text: string): { icon: string; color: (s: string) => string } {
  const t = text.toLowerCase();
  if (/^(error|\[error\]|\u2715|fail|exception|crash)/.test(t) || /\berror\b/.test(t)) {
    return { icon: "\u2715 ", color: TUI_STYLE.error };
  }
  if (/^(warn|\[warn\]|warning|\u25b2)/.test(t)) {
    return { icon: "\u25b2 ", color: TUI_STYLE.warning };
  }
  if (/^(\u2713|ok |done|success|saved|completed|resumed)/.test(t)) {
    return { icon: "\u2713 ", color: TUI_STYLE.success };
  }
  if (/^(\u26a1|aborted|interrupted)/.test(t)) {
    return { icon: "\u26a1 ", color: TUI_STYLE.warning };
  }
  // default: neutral info bullet
  return { icon: "\xb7 ", color: TUI_STYLE.system };
}

/** Slash-command output and system notices. */
export class SystemLineComponent implements Component {
  constructor(
    private readonly text: string,
    private readonly opts: TranscriptRenderOpts,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const { icon, color } = detectIcon(this.text);
    const lines = wrapContent(icon + this.text, width, color);
    return renderAccentLines(
      lines,
      "system",
      "raised",
      false,
      width,
    );
  }
}
