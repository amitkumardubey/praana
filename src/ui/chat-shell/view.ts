import type { Frame } from "../../terminal/render/frame.js";
import {
  createLayout,
  fillConstraint,
  lengthConstraint,
  splitLayout,
} from "../../terminal/index.js";
import { blockInner } from "../../terminal/widgets/block.js";
import { styleFg } from "../../terminal/core/style.js";
import { PALETTE } from "./palette.js";
import type { TranscriptState } from "./reducer.js";
import { renderTranscriptLines } from "./render-lines.js";
import type { StatusBarInput } from "../../status-bar.js";
import { formatStatusLine } from "../../status-bar.js";

const SCROLL_WINDOW = 30;

export interface ChatViewOptions {
  showThinking: boolean;
  markdownRendering: boolean;
  bootSummary?: string;
  showLogo: boolean;
  status: StatusBarInput;
  input: string;
  toast: string | null;
}

export function drawChatView(
  frame: Frame,
  transcript: TranscriptState,
  opts: ChatViewOptions
): void {
  const layout = createLayout([
    fillConstraint(1),
    lengthConstraint(3),
    lengthConstraint(2),
  ]);
  const [bodyArea, inputArea, statusArea] = splitLayout(layout, frame.area);

  // Transcript viewport
  const innerBody = blockInner(bodyArea, { border: "none", padding: 0 });
  const total = transcript.completed.length;
  const scrollOffset = 0; // scroll handled via model in program
  const end = Math.max(0, total - scrollOffset);
  const start = Math.max(0, end - SCROLL_WINDOW);
  const visible = transcript.completed.slice(start, end);

  const allEntries = [...visible];
  if (transcript.live) allEntries.push(transcript.live);

  const lines = renderTranscriptLines(allEntries, {
    showThinking: opts.showThinking,
    markdownRendering: opts.markdownRendering,
    width: innerBody.width,
  });

  if (opts.showLogo && opts.bootSummary) {
    lines.unshift(
      { text: "PRAANA", style: styleFg({}, PALETTE.assistant) },
      { text: opts.bootSummary, style: styleFg({}, PALETTE.muted) },
      { text: "", style: {} }
    );
  }

  let row = innerBody.y;
  for (const line of lines) {
    if (row >= innerBody.y + innerBody.height) break;
    frame.buffer.setString(innerBody.x, row, line.text, line.style, innerBody.width);
    row++;
  }

  if (transcript.busy && !transcript.live?.text.trim()) {
    frame.buffer.setString(
      innerBody.x,
      row,
      "working…",
      styleFg({}, PALETTE.thinking),
      innerBody.width
    );
  }

  // Input row
  const inputInner = blockInner(inputArea, { border: "plain", padding: 0 });
  const prompt = transcript.busy ? "working…" : (opts.input || "message or /command");
  frame.buffer.setString(
    inputInner.x,
    inputInner.y,
    `❯ ${prompt}`,
    styleFg({}, PALETTE.assistant),
    inputInner.width
  );

  // Status bar
  const statusText = opts.toast ?? formatStatusLine(opts.status);
  frame.buffer.setString(
    statusArea.x,
    statusArea.y,
    statusText.slice(0, statusArea.width),
    styleFg({}, PALETTE.muted),
    statusArea.width
  );
}
