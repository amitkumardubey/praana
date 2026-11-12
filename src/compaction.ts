import { CanonicalValidator, emitCanonicalTranscript, readFullSessionCanonicalRecords, type CanonicalRecord } from "./canonical-transcript.js";
import { eventsAfterResetBoundary } from "./event-log.js";
import type { ConversationMessage, ToolDefinition } from "./llm/types.js";
import { estimateTokens } from "./token-estimate.js";
import type { Event } from "./types.js";

/** Prefix components not already present in messages. Do not count an embedded snapshot twice. */
export interface RequestFrame {
  systemPrompt?: string;
  snapshot?: string;
  tools?: readonly ToolDefinition[];
}

/** Stable object keys, ordered arrays, and normal JSON escaping/toJSON semantics. */
function estimateJson(value: ConversationMessage | RequestFrame): number {
  const ordered = new WeakMap<object, Record<string, unknown>>();
  return estimateTokens(JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    let sorted = ordered.get(item);
    if (!sorted) {
      sorted = Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]));
      ordered.set(item, sorted);
    }
    return sorted;
  }));
}

/** Provider-independent estimate of all native fields, not an exact wire tokenizer. */
export function estimateMessageTokens(message: ConversationMessage): number {
  return estimateJson(message);
}

/** Messages must include the summary, retained history and current input, in send order. */
export function estimateRequestTokens(frame: RequestFrame, messages: readonly ConversationMessage[]): number {
  return estimateJson({ systemPrompt: frame.systemPrompt, snapshot: frame.snapshot, tools: frame.tools }) +
    messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export interface CompactionTurn {
  turnId: number;
  /** Only a following user_input proves that this turn is no longer in flight. */
  completed: boolean;
  eventIds: string[];
  records: CanonicalRecord[];
  messages: ConversationMessage[];
  estimatedTokens: number;
}

interface CanonicalEntry {
  eventId: string;
  record: CanonicalRecord;
}

function currentEntries(events: readonly Event[]): CanonicalEntry[] {
  const canonical = eventsAfterResetBoundary([...events]).filter((event) => event.kind === "canonical_message");
  const records = readFullSessionCanonicalRecords(canonical);
  let seenInput = false;
  return records.flatMap((record, index) => {
    if (record.kind === "user_input") seenInput = true;
    // Match canonical replay: a reset can strand results before the first new input.
    return !seenInput && record.kind === "tool_result" ? [] : [{ eventId: canonical[index].event_id, record }];
  });
}

/** Current-epoch units in log order. Invalid sequences throw CanonicalTranscriptError. */
export function buildTurns(events: readonly Event[]): CompactionTurn[] {
  const turns: CompactionTurn[] = [];
  const validator = new CanonicalValidator();
  for (const { eventId, record } of currentEntries(events)) {
    validator.accept(record);
    if (record.kind === "user_input") {
      if (turns.length) turns[turns.length - 1].completed = true;
      turns.push({ turnId: record.turnId, completed: false, eventIds: [], records: [], messages: [], estimatedTokens: 0 });
    }
    const turn = turns[turns.length - 1];
    turn.eventIds.push(eventId);
    turn.records.push(record);
  }
  for (const turn of turns) {
    const emittedCount = turn.records.filter((record) => ["user_input", "wrap_up", "assistant", "tool_result"].includes(record.kind)).length;
    // The strict emitter repairs a terminal pending batch; estimates cover recorded bytes only.
    turn.messages = emitCanonicalTranscript(turn.records).slice(0, emittedCount);
    turn.estimatedTokens = turn.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  }
  return turns;
}
