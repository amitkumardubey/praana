import type { Event } from "../../types.js";
import type { TranscriptEntry } from "./reducer.js";
import {
  formatToolDisplay,
  formatShellOutputForDisplay,
  summarizeResultForDisplay,
} from "./formatters.js";
import { formatToolResultRawText } from "../../tool-summary.js";

/** Rebuild TUI transcript entries from session event log (resume). */
export function buildTranscriptFromEvents(events: Event[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let nextId = 1;
  let groupCounter = 0;

  const push = (entry: Omit<TranscriptEntry, "id" | "group">) => {
    entries.push({ ...entry, id: `replay-${nextId++}`, group: groupCounter });
  };

  for (const ev of events) {
    switch (ev.kind) {
      case "user_message": {
        groupCounter++;
        const text = String(ev.payload.text ?? "").trim();
        if (text) push({ role: "user", text });
        break;
      }
      case "tool_call": {
        const toolName = String(ev.payload.tool ?? "tool");
        const args = (ev.payload.args ?? {}) as Record<string, unknown>;
        const display = formatToolDisplay(toolName, args);
        push({
          role: "tool",
          toolName,
          text: toolName,
          toolIcon: display.icon,
          toolLabel: display.label,
          toolPending: display.pending,
        });
        break;
      }
      case "tool_result": {
        const toolName = String(ev.payload.tool ?? "tool");
        const raw = formatToolResultRawText(ev.payload.result);
        const shellDisplay =
          toolName === "shell" ? formatShellOutputForDisplay(raw) : null;
        const summary = shellDisplay?.summary ?? summarizeResultForDisplay(raw);
        const isError =
          typeof ev.payload.result === "object" &&
          ev.payload.result !== null &&
          (ev.payload.result as { ok?: boolean }).ok === false;
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (
            entry?.role === "tool" &&
            entry.toolName === toolName &&
            entry.resultSummary === undefined
          ) {
            entries[i] = {
              ...entry,
              resultSummary: summary,
              resultText: raw,
              resultBody: shellDisplay?.body ?? undefined,
              isError: isError || (shellDisplay?.isError ?? false),
            };
            break;
          }
        }
        break;
      }
      case "agent_message": {
        const text = String(ev.payload.text ?? "").trim();
        if (text) push({ role: "assistant", text });
        break;
      }
      default:
        break;
    }
  }

  return entries;
}

/** Rough line budget for scroll windowing (terminals are line-limited). */
export function estimateEntryLines(
  entry: TranscriptEntry,
  terminalWidth = 80
): number {
  const lines = entry.text.split("\n").length;
  const wrapCols = Math.max(40, terminalWidth - 4);
  switch (entry.role) {
    case "user":
      return Math.max(4, lines + 3);
    case "assistant":
      return Math.max(2, lines + Math.ceil(entry.text.length / wrapCols));
    case "tool": {
      const summaryLines = entry.resultSummary ? 2 : 0;
      const bodyLines = entry.resultBody
        ? entry.resultBody.split("\n").length
        : 0;
      const contentLines = summaryLines + bodyLines;
      return entry.resultSummary
        ? Math.max(4, contentLines)
        : Math.max(2, contentLines);
    }
    case "thinking":
      return 3;
    case "turn_footer":
      return 3;
    case "system":
      return Math.max(1, lines);
    default:
      return Math.max(1, lines);
  }
}

export function sliceEntriesByLineBudget(
  entries: TranscriptEntry[],
  lineBudget: number,
  scrollOffsetLines: number,
  terminalWidth = 80
): {
  entries: TranscriptEntry[];
  startIndex: number;
  totalLines: number;
  maxScrollLines: number;
} {
  const weights = entries.map((entry) => estimateEntryLines(entry, terminalWidth));
  const totalLines = weights.reduce((a, b) => a + b, 0);
  const maxScrollLines = Math.max(0, totalLines - lineBudget);
  const offset = Math.min(Math.max(0, scrollOffsetLines), maxScrollLines);

  if (totalLines <= lineBudget) {
    return { entries, startIndex: 0, totalLines, maxScrollLines: 0 };
  }

  const topLine = Math.max(0, totalLines - lineBudget - offset);
  let start = 0;
  let lineAcc = 0;
  while (start < entries.length && lineAcc + (weights[start] ?? 1) <= topLine) {
    lineAcc += weights[start] ?? 1;
    start++;
  }

  let end = start;
  let windowLines = 0;
  while (end < entries.length && windowLines < lineBudget) {
    windowLines += weights[end] ?? 1;
    end++;
  }

  return {
    entries: entries.slice(start, end),
    startIndex: start,
    totalLines,
    maxScrollLines,
  };
}

