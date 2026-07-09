/**
 * Wrapper around pi-tui's Editor that applies inverse video styling
 * and vertical padding to the input bar.
 *
 * The prompt is rendered by reserving the Editor's left padding and
 * overlaying "❯ " on it. This keeps the prompt, continuation indent, and
 * cursor inside the declared width instead of overflowing by the prompt
 * width.
 */
import type { TUI, Component, Focusable } from "@earendil-works/pi-tui";
import { Editor, type EditorTheme, type EditorOptions } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";

const PROMPT = "❯ ";
const PROMPT_WIDTH = visibleWidth(PROMPT); // 2

function isBorderLine(line: string): boolean {
  const stripped = stripAnsi(line);
  return stripped.length === 0 || /^─+$/.test(stripped);
}

export class InvertedEditor implements Component, Focusable {
  readonly inner: Editor;
  private readonly paddingY: number;

  /** Focusable — synced to inner editor */
  get focused() { return this._focused; }
  set focused(v: boolean) { this._focused = v; this.inner.focused = v; }
  private _focused = false;

  constructor(tui: TUI, theme: EditorTheme, options?: EditorOptions & { paddingY?: number }) {
    // Reserve left padding equal to the prompt width so we can overlay the
    // prompt without exceeding the terminal width.
    this.inner = new Editor(tui, theme, { ...options, paddingX: PROMPT_WIDTH });
    this.paddingY = options?.paddingY ?? 1;
  }

  render(width: number): string[] {
    const lines = this.inner.render(width);
    const CURSOR_RE = /\x1b\[7m/g;
    const RESET_RE = /\x1b\[0m/g;
    const cursorStyle = "\x1b[1m"; // bold

    const blank = " ".repeat(width);
    const topPad = Array.from({ length: this.paddingY }, () => blank);
    const bottomPad = Array.from({ length: this.paddingY }, () => blank);

    const result: string[] = [...topPad];
    let seenTopBorder = false;
    let seenBottomBorder = false;
    let bottomBorderWasNonEmpty = false;
    let firstContentDone = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect top/bottom border lines. With the empty border theme used by
      // PRAANA these are empty strings; in other themes they are horizontal
      // box-drawing characters.
      if (!seenTopBorder && isBorderLine(line)) {
        result.push(line);
        seenTopBorder = true;
        continue;
      }
      if (seenTopBorder && !seenBottomBorder && isBorderLine(line)) {
        result.push(line);
        seenBottomBorder = true;
        bottomBorderWasNonEmpty = stripAnsi(line).length > 0;
        continue;
      }

      // Anything after the inner bottom border (e.g. autocomplete list) is
      // passed through unchanged.
      if (seenBottomBorder) {
        result.push(line);
        continue;
      }

      // Content line: replace the editor's left padding with the prompt/indent.
      const prefix = firstContentDone ? " ".repeat(PROMPT_WIDTH) : PROMPT;
      const rest = line.slice(PROMPT_WIDTH);
      let styled = `${prefix}${rest}`;
      styled = styled.replace(CURSOR_RE, cursorStyle).replace(RESET_RE, "");
      result.push(styled);
      firstContentDone = true;
    }

    // Only synthesize a visible bottom border if the inner editor did not
    // already render one. This avoids double borders when the theme provides
    // its own horizontal rule.
    if (!seenBottomBorder || !bottomBorderWasNonEmpty) {
      result.push("─".repeat(width));
    }
    result.push(...bottomPad);
    return result;
  }

  handleInput(data: string): void {
    this.inner.handleInput(data);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}
