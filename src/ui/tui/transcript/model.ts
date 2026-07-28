/**
 * Transcript entry model — used only for resume bootstrap (`buildTranscriptFromEvents`).
 * Live sessions flow through `TranscriptProjection`; the container renders entries.
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

// ─── Compaction / windowing ────────────────────────────────────────────────

export interface TranscriptCompactionOpts {
  persistThinkingMaxChars: number;
  persistToolBodyMaxChars: number;
}

export interface TranscriptWindowOpts {
  maxEntries: number;
  maxChars: number;
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

export function compactTranscriptEntry(
  entry: TranscriptEntry,
  opts: TranscriptCompactionOpts,
): TranscriptEntry {
  if (entry.role === "thinking") {
    return { ...entry, text: truncateText(entry.text, opts.persistThinkingMaxChars) };
  }
  if (entry.role === "tool") {
    return {
      ...entry,
      resultBody:
        opts.persistToolBodyMaxChars > 0 && entry.resultBody
          ? truncateText(entry.resultBody, opts.persistToolBodyMaxChars)
          : undefined,
    };
  }
  return entry;
}

function entryCharWeight(entry: TranscriptEntry): number {
  switch (entry.role) {
    case "user":
    case "assistant":
    case "thinking":
    case "system":
    case "turn_footer":
      return entry.text.length;
    case "tool":
      return (entry.resultBody?.length ?? 0) + (entry.resultText?.length ?? 0);
    case "recall":
      return entry.preview.length + (entry.query?.length ?? 0);
  }
}

/**
 * Advance an index to the next turn boundary (start of a new group). Keeps
 * complete turns when windowing. If the boundary would move past the end of
 * the array, the original index is returned so the caller can fall back to
 * keeping the last turn/entry.
 */
function advanceToTurnBoundary(
  entries: TranscriptEntry[],
  index: number,
): number {
  if (index <= 0 || index >= entries.length) return index;
  let boundary = index;
  while (
    boundary < entries.length &&
    entries[boundary]!.group === entries[boundary - 1]!.group
  ) {
    boundary++;
  }
  return boundary;
}

/**
 * Slice persisted transcript entries to a recent window while keeping turns
 * complete. The budget is applied from the end of the log so the newest turns
 * are retained.
 */
export function windowTranscriptEntries(
  entries: TranscriptEntry[],
  opts: TranscriptWindowOpts,
): TranscriptEntry[] {
  if (entries.length === 0) return entries;

  // Entry-count window, translated to a group boundary so we don't split turns.
  const rawEntryStart = Math.max(0, entries.length - opts.maxEntries);
  const entryStart = advanceToTurnBoundary(entries, rawEntryStart);
  const entryLimitGroup =
    entries[entryStart]?.group ?? entries[entries.length - 1]!.group;

  // Char budget from the end, also translated to a group boundary.
  let charBudget = opts.maxChars;
  let rawCharStart: number | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    charBudget -= entryCharWeight(entries[i]!);
    if (charBudget < 0) {
      rawCharStart = i + 1;
      break;
    }
  }
  const charLimitGroup =
    rawCharStart === null
      ? entries[0]!.group
      : entries[advanceToTurnBoundary(entries, rawCharStart)]?.group ??
        entries[entries.length - 1]!.group;

  const minGroup = Math.max(entryLimitGroup, charLimitGroup);
  return entries.filter((entry) => entry.group >= minGroup);
}

// ─── Resume rebuild ────────────────────────────────────────────────────────

export interface BuildTranscriptOpts {
  useUnicode?: boolean;
  window?: TranscriptWindowOpts;
}

/**
 * Rebuild transcript entries from a session event log on resume.
 * Maps only the event kinds relevant to display; skips scoring/engine events.
 * Applies a configurable window to the persisted transcript so resume does not
 * load an unbounded UI tree.
 */
export function buildTranscriptFromEvents(
  events: Event[],
  opts?: BuildTranscriptOpts,
): TranscriptEntry[] {
  const persistedEntries = events.flatMap((ev) => {
    if (ev.kind !== "ui_transcript") return [];
    return isPersistedTuiTranscriptPayload(ev.payload) ? [ev.payload.entry] : [];
  });
  if (persistedEntries.length > 0) {
    return opts?.window
      ? windowTranscriptEntries(persistedEntries, opts.window)
      : persistedEntries;
  }

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

  const entries = projection.entries();
  return opts?.window ? windowTranscriptEntries(entries, opts.window) : entries;
}
