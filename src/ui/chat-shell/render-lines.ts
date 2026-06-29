import stripAnsi from "strip-ansi";
import type { Style } from "../../terminal/core/style.js";
import { styleFg, Modifier, styleAddModifier, styleToAnsi, RESET_ANSI } from "../../terminal/core/style.js";
import type { TranscriptEntry } from "./reducer.js";
import { PALETTE } from "./palette.js";
import { needsTopMargin } from "./formatters.js";
import { reasoningSummary, formatThinkingDuration } from "./reasoning-summary.js";
import { renderMarkdown } from "../../render.js";

export interface RenderEntryOptions {
  showThinking?: boolean;
  markdownRendering?: boolean;
  width?: number;
  /**
   * When true the caller writes lines directly to a TTY (preserve/append mode).
   * Style is baked into `.text` as ANSI escape codes so the terminal renders
   * colour and bold. When false (default, buffer/alternate mode) `.text` must
   * be plain — ANSI would be stored as literal characters in buffer cells.
   */
  ttyOutput?: boolean;
}

export interface RenderedLine {
  text: string;
  style: Style;
}

/** Format a transcript entry into display lines for the terminal buffer. */
export function renderEntryLines(
  entry: TranscriptEntry,
  prevRole: string | undefined,
  opts: RenderEntryOptions = {}
): RenderedLine[] {
  const lines: RenderedLine[] = [];
  const margin = needsTopMargin(entry.role, prevRole);
  if (margin) lines.push({ text: "", style: {} });

  const plain = stripAnsi(entry.text);

  switch (entry.role) {
    case "user": {
      lines.push({ text: "You", style: styleFg({}, PALETTE.user) });
      for (const line of plain.split("\n")) {
        lines.push({ text: line, style: styleFg({}, PALETTE.user) });
      }
      break;
    }
    case "assistant": {
      if (!plain.trim()) break;
      const content = opts.markdownRendering
        ? opts.ttyOutput
          ? renderMarkdown(plain)          // keep ANSI — TTY renders it directly
          : stripAnsi(renderMarkdown(plain)) // strip ANSI — buffer stores chars
        : plain;
      const mdStyle: Style = opts.ttyOutput && opts.markdownRendering
        ? {} // markdown ANSI already encodes colour; don't add PALETTE on top
        : styleFg({}, PALETTE.text);
      for (const line of content.split("\n")) {
        lines.push({ text: line, style: mdStyle });
      }
      break;
    }
    case "thinking": {
      const { title, body } = reasoningSummary(plain);
      const duration =
        entry.durationMs !== undefined
          ? formatThinkingDuration(entry.durationMs)
          : undefined;
      const header = entry.durationMs !== undefined
        ? `Thought · ${duration}`
        : "Thinking…";
      lines.push({
        text: title ? `Thought: ${title}` : header,
        style: styleFg({}, PALETTE.thinking),
      });
      if (opts.showThinking && body) {
        for (const line of body.split("\n")) {
          lines.push({
            text: line,
            style: styleAddModifier(styleFg({}, PALETTE.thinking), Modifier.DIM),
          });
        }
      }
      break;
    }
    case "tool": {
      const icon = entry.toolIcon ?? "⚙";
      const label = entry.toolLabel ?? plain;
      const pending = entry.toolPending && !entry.resultSummary ? ` (${entry.toolPending})` : "";
      lines.push({
        text: `${icon} ${label}${pending}`,
        style: styleFg({}, entry.isError ? PALETTE.error : PALETTE.tool),
      });
      if (entry.resultSummary) {
        lines.push({
          text: `  ${entry.resultSummary}`,
          style: styleFg({}, entry.isError ? PALETTE.error : PALETTE.muted),
        });
      }
      if (entry.resultBody) {
        for (const line of entry.resultBody.split("\n").slice(0, 12)) {
          lines.push({
            text: `  ${line}`,
            style: styleAddModifier(styleFg({}, PALETTE.muted), Modifier.DIM),
          });
        }
      }
      break;
    }
    case "tool_result": {
      lines.push({
        text: entry.resultSummary ?? plain,
        style: styleFg({}, entry.isError ? PALETTE.error : PALETTE.muted),
      });
      break;
    }
    case "turn_footer":
    case "system": {
      lines.push({
        text: plain,
        style: styleAddModifier(styleFg({}, PALETTE.system), Modifier.DIM),
      });
      break;
    }
    default:
      lines.push({ text: plain, style: {} });
  }
  if (!opts.ttyOutput) return lines;
  // Bake each RenderedLine.style into .text as ANSI so the TTY sees the colour.
  // Empty style → no-op (e.g. assistant lines already carry markdown ANSI).
  return lines.map((l) => {
    const prefix = styleToAnsi(l.style);
    if (!prefix) return l;
    return { text: prefix + l.text + RESET_ANSI, style: {} };
  });
}


export function renderTranscriptLines(
  entries: TranscriptEntry[],
  opts: RenderEntryOptions = {}
): RenderedLine[] {
  const out: RenderedLine[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const prev = i > 0 ? entries[i - 1]?.role : undefined;
    out.push(...renderEntryLines(entry, prev, opts));
  }
  return out;
}
