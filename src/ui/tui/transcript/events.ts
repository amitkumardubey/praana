import type { TranscriptEntry } from "./model.js";

const TRANSCRIPT_ROLES = new Set([
  "user",
  "assistant",
  "thinking",
  "tool",
  "recall",
  "system",
  "turn_footer",
]);

export interface PersistedTuiTranscriptPayload {
  type: "entry";
  entry: TranscriptEntry;
}

export function isPersistedTuiTranscriptPayload(
  payload: unknown,
): payload is PersistedTuiTranscriptPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const candidate = payload as { type?: unknown; entry?: unknown };
  if (candidate.type !== "entry") return false;
  if (!candidate.entry || typeof candidate.entry !== "object" || Array.isArray(candidate.entry)) {
    return false;
  }
  const entry = candidate.entry as { id?: unknown; group?: unknown; role?: unknown };
  return (
    typeof entry.id === "string" &&
    typeof entry.group === "number" &&
    typeof entry.role === "string" &&
    TRANSCRIPT_ROLES.has(entry.role)
  );
}

export type TuiTranscriptEvent =
  | { type: "turn_started"; group: number }
  | { type: "user_submitted"; id: string; group: number; text: string }
  | { type: "assistant_delta"; id: string; group: number; delta: string }
  | { type: "thinking_delta"; id: string; group: number; delta: string }
  | { type: "streams_finalized"; group: number }
  | {
      type: "tool_call_started";
      id: string;
      group: number;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_call_finished";
      id: string;
      group: number;
      toolName: string;
      resultText: string;
      isError: boolean;
      args?: Record<string, unknown>;
    }
  | { type: "recall_chip"; id: string; group: number; preview: string; count: number; query?: string | null }
  | { type: "system_line"; id: string; group: number; text: string }
  | { type: "turn_footer"; id: string; group: number; text: string }
  | { type: "transcript_cleared" };
