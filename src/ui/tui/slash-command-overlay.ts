import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { showOverlay, hideOverlay, type OverlayHandle } from "./overlay.js";
import { TUI_STYLE } from "./theme.js";

export function showSlashCommandResult(renderer: CliRenderer, lines: string[]): OverlayHandle {
  const box = new BoxRenderable(renderer, {
    id: "slash-command-result",
    border: true,
    borderStyle: "rounded",
    padding: 1,
    flexDirection: "column",
    width: Math.min(70, (renderer.root.width ?? 80) - 4),
  });
  for (const line of lines) {
    box.add(new TextRenderable(renderer, { content: TUI_STYLE.text(line) }));
  }
  return showOverlay(renderer, box);
}

export function dismissSlashCommandResult(renderer: CliRenderer, handle: OverlayHandle): void {
  hideOverlay(renderer, handle);
}