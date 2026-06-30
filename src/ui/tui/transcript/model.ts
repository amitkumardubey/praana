/**
 * Transcript entry model — used only for resume bootstrap (`buildTranscriptFromEvents`).
 * Live sessions mutate `TranscriptContainer` children directly.
 */
import type { Event } from "../../../types.js";
import {
  formatToolDisplay,
  formatShellOutputForDisplay,
  summarizeResultForDisplay,
} from "../tool-icons.js";
import { formatToolResultRawText } from "../../../tool-summary.js";

// ─── Entry types ───────────────────────────────────────────────────────────

export type TranscriptRole =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "recall"
  | "system"
  | "turn_footer";

/** A single displayable row in the transcript. */
export type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | ThinkingEntry
  | ToolEntry
  | RecallEntry
  | SystemEntry
  | TurnFooterEntry;

export interface UserEntry {
  id: string;
  role: "user";
  group: number;
  text: string;
}

export interface AssistantEntry {
  id: string;
  role: "assistant";
  group: number;
  text: string;
}

export interface ThinkingEntry {
  id: string;
  role: "thinking";
  group: number;
  text: string;
}

export interface ToolEntry {
  id: string;
  role: "tool";
  group: number;
  toolName: string;
  toolIcon: string;
  toolLabel: string;
  toolPending: string;
  /** Compact single-line result summary, set when tool_result arrives. */
  resultSummary?: string;
  /** Full raw result text (for expansion). */
  resultText?: string;
  /** Expanded body (shell output etc.). */
  resultBody?: string | null;
  isError?: boolean;
  /** Passed at render time — not stored in replay bootstrap. */
  backgroundZones?: boolean;
}

export interface RecallEntry {
  id: string;
  role: "recall";
  group: number;
  /** Short quote from the top recall hit. */
  preview: string;
  count: number;
  /** The query string used for this recall, if available. */
  query?: string | null;
}

export interface SystemEntry {
  id: string;
  role: "system";
  group: number;
  text: string;
}

export interface TurnFooterEntry {
  id: string;
  role: "turn_footer";
  group: number;
  text: string;
}

// ─── Resume rebuild ────────────────────────────────────────────────────────

/**
 * Rebuild transcript entries from a session event log on resume.
 * Maps only the event kinds relevant to display; skips scoring/engine events.
 * No line-budget windowing — pi-tui handles scrollback natively.
 */
export function buildTranscriptFromEvents(
  events: Event[],
  opts?: { useUnicode?: boolean },
): TranscriptEntry[] {
  const useUnicode = opts?.useUnicode ?? true;
  const entries: TranscriptEntry[] = [];
  let nextId = 1;
  let groupCounter = 0;

  const push = (entry: UserEntry | AssistantEntry | ThinkingEntry | ToolEntry | RecallEntry | SystemEntry | TurnFooterEntry) => {
    entries.push(entry);
  };
  let entryId = 1;
  const nextEntry = <T extends TranscriptEntry>(partial: Omit<T, "id" | "group">) =>
    ({ ...partial, id: `replay-${entryId++}`, group: groupCounter } as T);

  for (const ev of events) {
    switch (ev.kind) {
      case "user_message": {
        groupCounter++;
        const text = String(ev.payload.text ?? "").trim();
        if (text) push(nextEntry<UserEntry>({ role: "user", text }));
        break;
      }
      case "tool_call": {
        const toolName = String(ev.payload.tool ?? "tool");
        const args = (ev.payload.args !== null &&
          typeof ev.payload.args === "object" &&
          !Array.isArray(ev.payload.args))
          ? (ev.payload.args as Record<string, unknown>)
          : {};
        const display = formatToolDisplay(toolName, args, { useUnicode });
        push(nextEntry<ToolEntry>({
          role: "tool",
          toolName,
          toolIcon: display.icon,
          toolLabel: display.label,
          toolPending: display.pending,
        }));
        break;
      }
      case "tool_result": {
        const toolName = String(ev.payload.tool ?? "tool");
        const raw = formatToolResultRawText(ev.payload.result);
        const shellDisplay =
          toolName === "shell" ? formatShellOutputForDisplay(raw) : null;
        const summary = shellDisplay?.summary ?? summarizeResultForDisplay(raw);

        const result = ev.payload.result;
        const isError =
          result !== null &&
          typeof result === "object" &&
          "ok" in result &&
          result.ok === false;

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
        if (text) push(nextEntry<AssistantEntry>({ role: "assistant", text }));
        break;
      }
      default:
        break;
    }
  }

  return entries;
}
