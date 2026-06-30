/**
 * Transcript entry model — used only for resume bootstrap (`buildTranscriptFromEvents`).
 * Live sessions mutate `TranscriptContainer` children directly.
 */
import type { Event } from "../../../types.js";
import { formatToolResultRawText } from "../../../tool-summary.js";
import { isPersistedTuiTranscriptPayload } from "./events.js";
import { TranscriptProjection } from "./projection.js";

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
  const projection = new TranscriptProjection({ useUnicode: opts?.useUnicode ?? true });
  let groupCounter = 0;
  let userFallbackId = 1;
  let assistantFallbackId = 1;
  let toolFallbackId = 1;
  let toolResultFallbackId = 1;
  const pendingLegacyToolCallIds: string[] = [];

  const nextFallbackId = (kind: "user" | "assistant" | "tool" | "tool-result") => {
    switch (kind) {
      case "user":
        return `replay-user-${userFallbackId++}`;
      case "assistant":
        return `replay-assistant-${assistantFallbackId++}`;
      case "tool":
        return `replay-tool-${toolFallbackId++}`;
      case "tool-result":
        return `replay-tool-result-${toolResultFallbackId++}`;
    }
  };

  const getToolCallId = (payload: Record<string, unknown>, kind: "tool" | "tool-result") => {
    const toolCallId = payload.toolCallId;
    if (typeof toolCallId === "string" && toolCallId) return toolCallId;
    if (kind === "tool") {
      const fallback = nextFallbackId(kind);
      pendingLegacyToolCallIds.push(fallback);
      return fallback;
    }
    if (kind === "tool-result") {
      const pending = pendingLegacyToolCallIds.shift();
      if (pending) return pending;
    }
    return nextFallbackId(kind);
  };

  for (const ev of events) {
    switch (ev.kind) {
      case "ui_transcript": {
        if (isPersistedTuiTranscriptPayload(ev.payload)) {
          const current = projection.entries();
          projection.load([...current, ev.payload.entry]);
        }
        break;
      }
      case "user_message": {
        groupCounter++;
        const text = String(ev.payload.text ?? "").trim();
        if (text) {
          const payload = ev.payload as Record<string, unknown>;
          projection.apply({
            type: "user_submitted",
            id: typeof payload.transcriptId === "string" && payload.transcriptId ? payload.transcriptId : nextFallbackId("user"),
            group: groupCounter,
            text,
          });
        }
        break;
      }
      case "tool_call": {
        const payload = ev.payload as Record<string, unknown>;
        const toolName = String(payload.tool ?? "tool");
        const args = payload.args !== null && typeof payload.args === "object" && !Array.isArray(payload.args)
          ? (payload.args as Record<string, unknown>)
          : {};
        const id = getToolCallId(payload, "tool");
        projection.apply({
          type: "tool_call_started",
          id,
          group: groupCounter,
          toolName,
          args,
        });
        break;
      }
      case "tool_result": {
        const payload = ev.payload as Record<string, unknown>;
        const toolName = String(payload.tool ?? "tool");
        const result = payload.result;
        const isError =
          result !== null &&
          typeof result === "object" &&
          "ok" in result &&
          (result as { ok?: unknown }).ok === false;
        const id = getToolCallId(payload, "tool-result");

        projection.apply({
          type: "tool_call_finished",
          id,
          group: groupCounter,
          toolName,
          resultText: formatToolResultRawText(result),
          isError,
        });
        break;
      }
      case "agent_message": {
        const text = String(ev.payload.text ?? "").trim();
        if (text) {
          const payload = ev.payload as Record<string, unknown>;
          const id =
            typeof payload.transcriptId === "string" && payload.transcriptId
              ? payload.transcriptId
              : nextFallbackId("assistant");
          projection.apply({
            type: "assistant_delta",
            id,
            group: groupCounter,
            delta: text,
          });
          projection.apply({ type: "streams_finalized", group: groupCounter });
        }
        break;
      }
      default:
        break;
    }
  }

  return projection.entries();
}
