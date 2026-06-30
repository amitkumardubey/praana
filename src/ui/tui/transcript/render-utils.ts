import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { TUI_STYLE, paintZoneLine, type ZoneKind, type TextStyle } from "../theme.js";
import type { TranscriptRole } from "./model.js";

const ACCENT: Record<TranscriptRole, TextStyle> = {
  user: TUI_STYLE.user,
  assistant: TUI_STYLE.assistant,
  thinking: TUI_STYLE.thinking,
  tool: TUI_STYLE.tool,
  recall: TUI_STYLE.memory,
  system: TUI_STYLE.muted,
  turn_footer: TUI_STYLE.faint,
};

export function accentBar(role: TranscriptRole): string {
  return ACCENT[role]("▌");
}

export function renderAccentLines(
  lines: string[],
  role: TranscriptRole,
  zone: ZoneKind,
  backgroundZones: boolean,
  width: number,
): string[] {
  const bar = accentBar(role);
  const indent = "   ";
  const blank = paintZoneLine("", zone, backgroundZones, width);
  const painted = lines.map((line, i) => {
    const row = (i === 0 ? `${bar}  ` : indent) + line;
    return paintZoneLine(row, zone, backgroundZones, width);
  });
  return [blank, ...painted, blank];
}

export function wrapContent(
  text: string,
  width: number,
  styler: (s: string) => string,
): string[] {
  const contentWidth = Math.max(10, width - 4);
  return wrapTextWithAnsi(styler(text), contentWidth);
}
