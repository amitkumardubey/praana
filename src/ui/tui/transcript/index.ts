/**
 * Lightweight transcript index used for virtual mounting.
 *
 * `events.jsonl` remains the canonical full-fidelity store. This index keeps
 * compact display metadata in memory and references source events so full
 * thinking/tool content can be resolved lazily on expansion.
 */
import type { Event } from "../../../types.js";
import { buildTranscriptFromEvents } from "./model.js";
import type { TranscriptEntry, ToolEntry } from "./model.js";

export interface TranscriptIndex {
  groups: TranscriptGroup[];
}

export interface TranscriptGroup {
  /** Turn group number, monotonically increasing within a session. */
  group: number;
  /** Ordered entries belonging to this turn group. */
  entries: IndexedTranscriptEntry[];
}

/** Display entry plus optional source reference for lazy expansion. */
export type IndexedTranscriptEntry = TranscriptEntry & {
  /** Event that contains the full content for expansion. */
  sourceEventId?: string;
  /** True when this entry can be expanded to show more detail. */
  expandable?: boolean;
  /** Current expansion state (UI-only, session-local). */
  expanded?: boolean;
};

export interface ExpandedContent {
  ok: true;
  text: string;
}

export interface ExpandedContentError {
  ok: false;
  error: string;
}

export type ExpandedContentResult = ExpandedContent | ExpandedContentError;

/**
 * Build a lightweight transcript index from session events.
 * Returns all groups; the virtual container decides how many to mount.
 */
export function buildTranscriptIndex(
  events: Event[],
  opts?: { useUnicode?: boolean },
): TranscriptIndex {
  // Map tool_result events by a stable call id so we can attach source
  // references to the matching display entry.
  const toolResultEventById = new Map<string, Event>();
  const toolResultEventsByToolName = new Map<string, Event[]>();

  for (const ev of events) {
    if (ev.kind !== "tool_result") continue;
    const payload = ev.payload as Record<string, unknown>;
    const toolCallId =
      typeof payload.toolCallId === "string" && payload.toolCallId
        ? payload.toolCallId
        : null;
    if (toolCallId) {
      toolResultEventById.set(toolCallId, ev);
    } else {
      const toolName = String(payload.tool ?? "tool");
      const list = toolResultEventsByToolName.get(toolName) ?? [];
      list.push(ev);
      toolResultEventsByToolName.set(toolName, list);
    }
  }

  const entries = buildTranscriptFromEvents(events, {
    useUnicode: opts?.useUnicode ?? true,
  });

  // Match pending tool entries to unmatched tool_result events in order when
  // call ids are absent (legacy events).
  const unmatchedToolResultsByName = new Map<string, Event[]>();
  for (const [name, list] of toolResultEventsByToolName) {
    unmatchedToolResultsByName.set(name, [...list]);
  }

  const groups = new Map<number, IndexedTranscriptEntry[]>();

  for (const entry of entries) {
    const indexed: IndexedTranscriptEntry = { ...entry };

    if (entry.role === "tool") {
      const source = toolResultEventById.get(entry.id) ??
        unmatchedToolResultsByName.get(entry.toolName)?.shift();
      if (source) {
        indexed.sourceEventId = source.event_id;
        indexed.expandable = true;
      }
    } else if (entry.role === "thinking") {
      // Thinking is already persisted verbatim in ui_transcript events, but
      // still mark it expandable if it is non-trivial.
      indexed.expandable = entry.text.length > 0;
    }

    const list = groups.get(entry.group) ?? [];
    list.push(indexed);
    groups.set(entry.group, list);
  }

  return {
    groups: Array.from(groups.entries())
      .sort(([a], [b]) => a - b)
      .map(([group, groupEntries]) => ({ group, entries: groupEntries })),
  };
}

/**
 * Resolve the full expanded text for a transcript entry from the event log.
 */
export function resolveExpandedContent(
  entry: IndexedTranscriptEntry,
  events: Event[],
): ExpandedContentResult {
  if (!entry.expandable) {
    return { ok: false, error: "Entry is not expandable" };
  }

  if (entry.role === "thinking") {
    return { ok: true, text: entry.text };
  }

  if (entry.role === "tool") {
    if (!entry.sourceEventId) {
      return {
        ok: false,
        error: "No source event recorded for this tool result",
      };
    }
    const source = events.find((e) => e.event_id === entry.sourceEventId);
    if (!source || source.kind !== "tool_result") {
      return {
        ok: false,
        error: `Source event ${entry.sourceEventId} not found`,
      };
    }
    const payload = source.payload as Record<string, unknown>;
    const result = payload.result;
    if (result === null || typeof result !== "object") {
      return {
        ok: false,
        error: "Source event has no structured result",
      };
    }
    const text = formatToolResultForExpansion(result as Record<string, unknown>);
    return { ok: true, text };
  }

  return { ok: false, error: "Unsupported entry role for expansion" };
}

function formatToolResultForExpansion(result: Record<string, unknown>): string {
  if (typeof result.content === "string") {
    return result.content;
  }
  if (typeof result.stdout === "string" || typeof result.stderr === "string") {
    const parts: string[] = [];
    if (typeof result.stdout === "string" && result.stdout) {
      parts.push(result.stdout);
    }
    if (typeof result.stderr === "string" && result.stderr) {
      parts.push(
        result.stderr
          .split("\n")
          .map((line) => `[stderr] ${line}`)
          .join("\n"),
      );
    }
    return parts.join("\n");
  }
  if (typeof result.output === "string") {
    return result.output;
  }
  return JSON.stringify(result, null, 2);
}
