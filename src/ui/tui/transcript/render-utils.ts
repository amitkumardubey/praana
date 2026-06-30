import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { PALETTE, paintZoneLine, type ZoneKind } from "../theme.js";
import type { TranscriptRole } from "./model.js";

const ACCENT: Record<TranscriptRole, string> = {
  user: PALETTE.user,
  assistant: PALETTE.assistant,
  thinking: PALETTE.thinking,
  tool: PALETTE.tool,
  recall: PALETTE.memory,
  system: PALETTE.muted,
  turn_footer: PALETTE.faint,
};

export function accentBar(role: TranscriptRole): string {
  return chalk.hex(ACCENT[role])("▌");
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
  return lines.map((line, i) => {
    const row = (i === 0 ? `${bar} ` : indent) + line;
    return paintZoneLine(row, zone, backgroundZones, width);
  });
}

export function wrapContent(
  text: string,
  width: number,
  styler: (s: string) => string,
): string[] {
  const contentWidth = Math.max(10, width - 4);
  return wrapTextWithAnsi(styler(text), contentWidth);
}
