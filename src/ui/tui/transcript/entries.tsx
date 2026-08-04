/**
 * Solid transcript entry rows — visual parity with imperative components/*.ts.
 */
import { Show } from "solid-js";
import chalk from "chalk";
import { TUI_STYLE, paintZoneLine, type ZoneKind } from "../theme.js";
import { wrapContent } from "./render-utils.js";
import { buildMarkdownSyntaxStyle } from "./markdown-theme.js";
import type { IndexedTranscriptEntry } from "./index.js";
import type { TranscriptRenderOpts } from "./opts.js";

const BODY_PREVIEW_LINES = 24;

function detectSystemIcon(text: string): { icon: string; color: (s: string) => string } {
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
  return { icon: "\xb7 ", color: TUI_STYLE.system };
}

function paintThinking(text: string, expanded: boolean): string {
  const rawLines = text.split("\n");
  const visibleLines = expanded ? rawLines : [];
  const lineCount = rawLines.filter((l) => l.trim()).length;
  const header = expanded
    ? lineCount > 1
      ? `\u25be thinking (${lineCount} lines)`
      : "\u25be thinking"
    : `\u25be thinking ${lineCount} lines (collapsed)`;
  const body = visibleLines.join("\n").trim();
  return body ? `${header}\n${body}` : header;
}

function paintToolHeader(
  entry: Extract<IndexedTranscriptEntry, { role: "tool" }>,
  width: number,
): string {
  const icon = TUI_STYLE.faint(entry.toolIcon);
  const label = TUI_STYLE.muted(entry.toolLabel);
  if (entry.resultSummary === undefined) {
    return paintZoneLine(
      `  ${icon} ${label} ${chalk.dim(entry.toolPending)}`,
      "raised" as ZoneKind,
      false,
      width,
    );
  }
  const summaryStyle = entry.isError ? TUI_STYLE.error : TUI_STYLE.success;
  return paintZoneLine(
    `  ${icon} ${label} ${summaryStyle(entry.resultSummary)}`,
    "raised" as ZoneKind,
    false,
    width,
  );
}

function paintToolBody(
  entry: Extract<IndexedTranscriptEntry, { role: "tool" }>,
  width: number,
): string {
  if (!entry.resultBody || (!entry.expanded && !entry.isError && entry.toolName !== "shell")) {
    return "";
  }
  const bodyWidth = Math.max(10, width - 7);
  const indent = "    ";
  const rawLines = entry.resultBody.split("\n");
  const shown = rawLines.slice(0, BODY_PREVIEW_LINES);
  const lines: string[] = [];
  for (const l of shown) {
    for (const wl of wrapContent(chalk.dim(l), bodyWidth)) {
      lines.push(paintZoneLine(`${indent}${wl}`, "raised" as ZoneKind, false, width));
    }
  }
  if (rawLines.length > BODY_PREVIEW_LINES) {
    lines.push(
      paintZoneLine(
        TUI_STYLE.faint(`${indent}… +${rawLines.length - BODY_PREVIEW_LINES} more lines`),
        "raised" as ZoneKind,
        false,
        width,
      ),
    );
  }
  return lines.join("\n");
}

export function TranscriptEntryView(props: {
  entry: IndexedTranscriptEntry;
  opts: TranscriptRenderOpts;
  streaming: boolean;
  selected: boolean;
  width: number;
}) {
  const e = props.entry;

  if (e.role === "user") {
    return (
      <box id={`entry-${e.id}`} flexDirection="column">
        <text>{TUI_STYLE.user(e.text)}</text>
      </box>
    );
  }

  if (e.role === "assistant") {
    return (
      <box id={`entry-${e.id}`} flexDirection="column" flexGrow={1}>
        <Show
          when={props.opts.markdownRendering}
          fallback={<text>{TUI_STYLE.text(e.text)}</text>}
        >
          <markdown
            content={e.text}
            streaming={props.streaming}
            syntaxStyle={buildMarkdownSyntaxStyle(props.opts.syntaxTheme)}
            flexGrow={1}
          />
        </Show>
      </box>
    );
  }

  if (e.role === "thinking") {
    return (
      <box id={`entry-${e.id}`} flexDirection="column">
        <text>{TUI_STYLE.thinking(paintThinking(e.text, e.expanded ?? true))}</text>
      </box>
    );
  }

  if (e.role === "tool") {
    const body = paintToolBody(e, props.width);
    return (
      <box id={`entry-${e.id}`} flexDirection="column">
        <text>{paintToolHeader(e, props.width)}</text>
        <Show when={body.length > 0}>
          <text>{body}</text>
        </Show>
      </box>
    );
  }

  if (e.role === "recall") {
    const label = TUI_STYLE.memory(`◆ recall ${e.count}`);
    const queryPart = e.query ? TUI_STYLE.faint(` · "${e.query.slice(0, 40)}"`) : "";
    const previewPart = e.preview ? TUI_STYLE.faint(` → "${e.preview.slice(0, 48)}"`) : "";
    return (
      <box id={`entry-${e.id}`} flexDirection="row">
        <text>{label + queryPart + previewPart}</text>
      </box>
    );
  }

  if (e.role === "turn_footer") {
    return (
      <box id={`entry-${e.id}`} flexDirection="row">
        <text>
          {paintZoneLine(`   ${chalk.dim(e.text)}`, "canvas" satisfies ZoneKind, false, props.width)}
        </text>
      </box>
    );
  }

  const { icon, color } = detectSystemIcon(e.text);
  return (
    <box id={`entry-${e.id}`} flexDirection="column">
      <text>{color(icon + e.text)}</text>
    </box>
  );
}
