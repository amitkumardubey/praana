/**
 * Solid transcript entry rows — visual parity with imperative components/*.ts.
 */
import { For, Show } from "solid-js";
import { TUI_STYLE, truncateSegments, type SpanStyle, type TextSegment } from "../theme.js";
import { wrapContent } from "./render-utils.js";
import { buildMarkdownSyntaxStyle } from "./markdown-theme.js";
import type { IndexedTranscriptEntry } from "./index.js";
import type { TranscriptRenderOpts } from "./opts.js";

const BODY_PREVIEW_LINES = 24;

function detectSystemIcon(text: string): { icon: string; style: SpanStyle } {
  const t = text.toLowerCase();
  if (/^(error|\[error\]|\u2715|fail|exception|crash)/.test(t) || /\berror\b/.test(t)) {
    return { icon: "\u2715 ", style: TUI_STYLE.error };
  }
  if (/^(warn|\[warn\]|warning|\u25b2)/.test(t)) {
    return { icon: "\u25b2 ", style: TUI_STYLE.warning };
  }
  if (/^(\u2713|ok |done|success|saved|completed|resumed)/.test(t)) {
    return { icon: "\u2713 ", style: TUI_STYLE.success };
  }
  if (/^(\u26a1|aborted|interrupted)/.test(t)) {
    return { icon: "\u26a1 ", style: TUI_STYLE.warning };
  }
  return { icon: "\xb7 ", style: TUI_STYLE.system };
}

function thinkingText(text: string, expanded: boolean): string {
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

function toolHeaderSegments(
  entry: Extract<IndexedTranscriptEntry, { role: "tool" }>,
  width: number,
): TextSegment[] {
  const segs: TextSegment[] = [
    { text: "  " },
    { text: entry.toolIcon, style: TUI_STYLE.faint },
    { text: " " },
    { text: entry.toolLabel, style: TUI_STYLE.muted },
    { text: " " },
  ];
  if (entry.resultSummary === undefined) {
    segs.push({ text: entry.toolPending, style: TUI_STYLE.faint });
  } else {
    segs.push({
      text: entry.resultSummary,
      style: entry.isError ? TUI_STYLE.error : TUI_STYLE.success,
    });
  }
  return truncateSegments(segs, width);
}

function toolBodyLines(
  entry: Extract<IndexedTranscriptEntry, { role: "tool" }>,
  width: number,
): TextSegment[][] {
  if (!entry.resultBody || (!entry.expanded && !entry.isError && entry.toolName !== "shell")) {
    return [];
  }
  const bodyWidth = Math.max(10, width - 7);
  const indent = "    ";
  const rawLines = entry.resultBody.split("\n");
  const shown = rawLines.slice(0, BODY_PREVIEW_LINES);
  const lines: TextSegment[][] = [];
  for (const l of shown) {
    for (const wl of wrapContent(l, bodyWidth)) {
      lines.push(truncateSegments([{ text: `${indent}${wl}`, style: TUI_STYLE.faint }], width));
    }
  }
  if (rawLines.length > BODY_PREVIEW_LINES) {
    lines.push(
      truncateSegments(
        [
          {
            text: `${indent}… +${rawLines.length - BODY_PREVIEW_LINES} more lines`,
            style: TUI_STYLE.faint,
          },
        ],
        width,
      ),
    );
  }
  return lines;
}

function SegmentLine(props: { segments: TextSegment[] }) {
  return (
    <text>
      <For each={props.segments}>{(s) => s.style ? <span style={s.style}>{s.text}</span> : s.text}</For>
    </text>
  );
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
        <text>{e.text}</text>
      </box>
    );
  }

  if (e.role === "assistant") {
    return (
      <box id={`entry-${e.id}`} flexDirection="column">
        <Show
          when={props.opts.markdownRendering}
          fallback={<text>{e.text}</text>}
        >
          <markdown
            content={e.text}
            streaming={props.streaming}
            syntaxStyle={buildMarkdownSyntaxStyle(props.opts.syntaxTheme)}
          />
        </Show>
      </box>
    );
  }

  if (e.role === "thinking") {
    return (
      <box id={`entry-${e.id}`} flexDirection="column">
        <text>
          <span style={TUI_STYLE.thinking}>{thinkingText(e.text, e.expanded ?? true)}</span>
        </text>
      </box>
    );
  }

  if (e.role === "tool") {
    const bodyLines = toolBodyLines(e, props.width);
    return (
      <box id={`entry-${e.id}`} flexDirection="column">
        <SegmentLine segments={toolHeaderSegments(e, props.width)} />
        <For each={bodyLines}>{(line) => <SegmentLine segments={line} />}</For>
      </box>
    );
  }

  if (e.role === "recall") {
    const segs: TextSegment[] = [{ text: `\u25c6 recall ${e.count}`, style: TUI_STYLE.memory }];
    if (e.query) segs.push({ text: ` · "${e.query.slice(0, 40)}"`, style: TUI_STYLE.faint });
    if (e.preview) segs.push({ text: ` → "${e.preview.slice(0, 48)}"`, style: TUI_STYLE.faint });
    return (
      <box id={`entry-${e.id}`} flexDirection="row">
        <SegmentLine segments={segs} />
      </box>
    );
  }

  if (e.role === "turn_footer") {
    return (
      <box id={`entry-${e.id}`} flexDirection="row">
        <SegmentLine
          segments={truncateSegments(
            [{ text: `   ${e.text}`, style: TUI_STYLE.faint }],
            props.width,
          )}
        />
      </box>
    );
  }

  const { icon, style } = detectSystemIcon(e.text);
  return (
    <box id={`entry-${e.id}`} flexDirection="column">
      <text>
        <span style={style}>{icon + e.text}</span>
      </text>
    </box>
  );
}
