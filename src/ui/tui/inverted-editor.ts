/**
 * Wrapper around pi-tui's Editor that applies inverse video styling
 * and vertical padding to the input bar.
 */
import type { TUI, Component, Focusable } from "@earendil-works/pi-tui";
import { Editor, type EditorTheme, type EditorOptions } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";

export class InvertedEditor implements Component, Focusable {
  readonly inner: Editor;
  private readonly paddingY: number;

  /** Focusable — synced to inner editor */
  get focused() { return this._focused; }
  set focused(v: boolean) { this._focused = v; this.inner.focused = v; }
  private _focused = false;

  constructor(tui: TUI, theme: EditorTheme, options?: EditorOptions & { paddingY?: number }) {
    this.inner = new Editor(tui, theme, options);
    this.paddingY = options?.paddingY ?? 1;
  }

  render(width: number): string[] {
    const lines = this.inner.render(width);
    const CURSOR_RE = /\x1b\[7m/g;
    const RESET_RE = /\x1b\[0m/g;
    const cursorStyle = "\x1b[1m";        // bold

    const PROMPT = "❯ ";
    const promptW = visibleWidth(PROMPT);  // 2
    const blank = " ".repeat(width);
    const topPad = Array.from({ length: this.paddingY }, () => blank);
    const bottomPad = Array.from({ length: this.paddingY }, () => blank);

    const result: string[] = [...topPad];
    for (let i = 0; i < lines.length; i++) {
      const isContent = i > 0 && i < lines.length - 1;
      const isFirstContent = isContent && i === 1;
      if (!isContent) {
        result.push(lines[i]);
        continue;
      }
      // Content line: strip Editor's paddingX left/right spaces, add our prefix
      const prefix = isFirstContent ? PROMPT : " ".repeat(promptW);
      const inner = lines[i].replace(/^ /, "").replace(/ +$/, "");
      const innerVw = visibleWidth(inner);
      const targetPad = Math.max(0, width - promptW - innerVw);
      let styled = `${prefix}${inner}${" ".repeat(targetPad)}`;
      styled = styled.replace(CURSOR_RE, cursorStyle).replace(RESET_RE, "");
      result.push(styled);
    }
    // Bottom border
    result.push("─".repeat(width));
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
