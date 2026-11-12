import { CanonicalTranscriptError, CanonicalValidator, emitCanonicalTranscript, readCanonicalEntries, type CanonicalRecord } from "./canonical-transcript.js";
import { findLastResetBoundaryIndex } from "./event-log.js";
import { renderSummaryMessage, SESSION_START_EPOCH, type FrozenState } from "./frozen-summary.js";
import type { ConversationMessage, ToolDefinition } from "./llm/types.js";
import { estimateTokens } from "./token-estimate.js";
import type { Event } from "./types.js";

export const DEFAULT_CONTEXT_LIMIT_RATIO = 0.80;
export const DEFAULT_TAIL_TURNS = 4;
export const DEFAULT_TOKENS_RESERVE = 4096;
export const DEFAULT_POST_REWRITE_MARGIN = 0.15;
export const DEFAULT_STUB_KEEP_RECENT = 3;
/** Avoid replacing small outputs whose likely savings do not justify stub overhead. */
export const DEFAULT_STUB_MIN_TOKENS = 256;
export const DEFAULT_SUMMARY_TIMEOUT_MS = 60000;

/** Module-local policy, not public configuration. */
export interface CompactionOptions {
  contextLimitRatio: number;
  tailTurns: number;
  tokensReserve: number;
  /** Effective output cap of this request; omitted means tokensReserve. */
  effectiveMaxTokens?: number;
  postRewriteMargin: number;
  stubKeepRecent: number;
  stubMinTokens: number;
  summaryTimeoutMs: number;
}

export const DEFAULT_COMPACTION_OPTIONS: Readonly<CompactionOptions> = Object.freeze({
  contextLimitRatio: DEFAULT_CONTEXT_LIMIT_RATIO,
  tailTurns: DEFAULT_TAIL_TURNS,
  tokensReserve: DEFAULT_TOKENS_RESERVE,
  postRewriteMargin: DEFAULT_POST_REWRITE_MARGIN,
  stubKeepRecent: DEFAULT_STUB_KEEP_RECENT,
  stubMinTokens: DEFAULT_STUB_MIN_TOKENS,
  summaryTimeoutMs: DEFAULT_SUMMARY_TIMEOUT_MS,
});

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

/** Fixed visual allowance per image; base64 bytes do not represent text tokens. */
export const IMAGE_TOKEN_ALLOWANCE = 1600;

/** Provider-independent estimate of all native fields, not an exact wire tokenizer. */
export function estimateMessageTokens(message: ConversationMessage): number {
  if (message.role !== "user" || typeof message.content === "string") return estimateJson(message);
  let imageTokens = 0;
  const content = message.content.map((part) => {
    if (part.type !== "image") return part;
    imageTokens += IMAGE_TOKEN_ALLOWANCE;
    const { data: _data, ...metadata } = part;
    return metadata;
  });
  return imageTokens + estimateJson({ ...message, content } as ConversationMessage);
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

function groupTurns(events: readonly Event[]): CompactionTurn[] {
  const turns: CompactionTurn[] = [];
  for (const { eventId, record } of readCanonicalEntries(events)) {
    if (record.kind === "user_input") {
      if (turns.length) turns[turns.length - 1].completed = true;
      turns.push({ turnId: record.turnId, completed: false, eventIds: [], records: [], messages: [], estimatedTokens: 0 });
    }
    const turn = turns[turns.length - 1];
    if (!turn) throw new CanonicalTranscriptError("invalid_turn", 0, "record must follow a user_input");
    turn.eventIds.push(eventId);
    turn.records.push(record);
  }
  return turns;
}

function turnView(events: readonly Event[], options: { estimate?: boolean } = {}): CompactionTurn[] {
  const turns = groupTurns(events);
  const validator = new CanonicalValidator();
  for (const turn of turns) {
    for (const record of turn.records) validator.accept(record);
    const emittedCount = turn.records.filter((record) => ["user_input", "wrap_up", "assistant", "tool_result"].includes(record.kind)).length;
    // The strict emitter repairs a terminal pending batch; estimates cover recorded bytes only.
    turn.messages = emitCanonicalTranscript(turn.records).slice(0, emittedCount);
    if (options.estimate !== false) turn.estimatedTokens = turn.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  }
  return turns;
}

/** Current-epoch units in log order. Invalid sequences throw CanonicalTranscriptError. */
export function buildTurns(events: readonly Event[], options: { estimate?: boolean } = {}): CompactionTurn[] {
  return turnView(events, options);
}

export type MaterializationErrorCode = "pending_batch" | "invalid_state";

export class MaterializationError extends Error {
  constructor(public readonly code: MaterializationErrorCode, detail: string) {
    super(`Cannot materialize history: ${detail}`);
    this.name = "MaterializationError";
  }
}

export type MaterializationResult =
  | { ok: true; messages: ConversationMessage[] }
  | { ok: false; error: MaterializationError | CanonicalTranscriptError };

/**
 * Pure replay of restored state and raw events (readAll({ includeInternal: true })).
 * Only completed turns may be folded. Pending terminal batches are not repaired:
 * invented results would change already-materialized bytes when real results arrive.
 */
export function materializeHistory(state: FrozenState, events: readonly Event[]): MaterializationResult {
  try {
    const resetIndex = findLastResetBoundaryIndex([...events]);
    const resetEpoch = resetIndex < 0 ? SESSION_START_EPOCH : events[resetIndex].event_id;
    if (state.resetEpoch !== resetEpoch) throw new MaterializationError("invalid_state", "frozen state belongs to another reset epoch");
    if ((state.summary === null) !== (state.boundaryEventId === null)) {
      throw new MaterializationError("invalid_state", "summary and boundary must both be present or both be null");
    }
    // A committed prefix is no longer replayed; only its turn boundaries matter.
    const turns = groupTurns(events);
    const cut = state.boundaryEventId === null ? -1 : turns.findIndex((turn) => turn.completed && turn.eventIds.at(-1) === state.boundaryEventId);
    if (state.boundaryEventId !== null && cut < 0) {
      throw new MaterializationError("invalid_state", "boundary must end a completed turn in the current epoch");
    }
    const validator = new CanonicalValidator();
    for (const turn of turns.slice(cut + 1)) {
      for (const record of turn.records) validator.accept(record);
    }
    if (validator.repairs().length) throw new MaterializationError("pending_batch", "the terminal tool batch has unrecorded results");
    const results = new Set(turns.flatMap((turn) => turn.records.flatMap((record, index) => record.kind === "tool_result" ? [turn.eventIds[index]] : [])));
    const stubs = new Map<string, string>();
    for (const stub of state.stubSet) {
      if (!results.has(stub.eventId) || stubs.has(stub.eventId)) {
        throw new MaterializationError("invalid_state", "stub ids must be unique current-epoch canonical tool results");
      }
      stubs.set(stub.eventId, stub.stubText);
    }
    const tail = turns.slice(cut + 1).flatMap((turn) => turn.records.map((record, index): CanonicalRecord => {
      const eventId = turn.eventIds[index];
      return record.kind === "tool_result" && stubs.has(eventId)
        ? { ...record, message: { ...record.message, text: stubs.get(eventId)! } }
        : record;
    }));
    return { ok: true, messages: [
      ...(state.summary === null ? [] : [renderSummaryMessage(state.summary)]),
      ...emitCanonicalTranscript(tail),
    ] };
  } catch (error) {
    if (error instanceof MaterializationError || error instanceof CanonicalTranscriptError) return { ok: false, error };
    throw error;
  }
}

export interface RequestFill {
  inputTokens: number;
  reservedOutputTokens: number;
  contextWindowTokens: number;
  usableTokens: number;
  totalTokens: number;
  /** Input divided by window minus this request's effective output cap; not clamped. */
  ratio: number;
  fits: boolean;
}

export type CapacityErrorKind = "reserve_exceeds_window" | "invalid_capacity" | "request_exceeds_capacity";

/** Values only: the integration layer must make terminal capacity stops exit headless runs non-zero. */
export interface CapacityErrorOutcome {
  status: "capacity_error";
  kind: CapacityErrorKind;
  message: string;
}

export type RequestFillResult = { ok: true; fill: RequestFill } | { ok: false; error: CapacityErrorOutcome };

function capacityError(kind: CapacityErrorKind, detail: string): RequestFillResult {
  const guidance = kind === "invalid_capacity"
    ? "Correct the configuration or model catalog entry before continuing."
    : "Use /clear or a larger-context model before continuing.";
  return { ok: false, error: { status: "capacity_error", kind, message: `${detail} ${guidance}` } };
}

/**
 * Account for a complete prospective request of any kind, including summary/batch
 * requests. Supply each request's own effectiveMaxTokens, never its summary cap.
 * An oversized input is measurable (fits=false), so a rewrite can still be tried;
 * an invalid reserve/window cannot be admitted or assigned a clamped fill ratio.
 */
export function requestFill(
  frame: RequestFrame,
  messages: readonly ConversationMessage[],
  contextWindowTokens: number,
  options: Partial<CompactionOptions> = {},
): RequestFillResult {
  const reservedOutputTokens = options.effectiveMaxTokens ?? options.tokensReserve ?? DEFAULT_TOKENS_RESERVE;
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    return capacityError("invalid_capacity", "The context window must be a positive safe-integer token count.");
  }
  if (!Number.isSafeInteger(reservedOutputTokens) || reservedOutputTokens < 0) {
    return capacityError("invalid_capacity", "The effective output cap must be a non-negative safe-integer token count.");
  }
  if (reservedOutputTokens >= contextWindowTokens) {
    return capacityError("reserve_exceeds_window", `The effective output reserve (${reservedOutputTokens}) is at or above the context window (${contextWindowTokens}).`);
  }
  const inputTokens = estimateRequestTokens(frame, messages);
  const usableTokens = contextWindowTokens - reservedOutputTokens;
  return { ok: true, fill: {
    inputTokens, reservedOutputTokens, contextWindowTokens, usableTokens,
    totalTokens: inputTokens + reservedOutputTokens,
    ratio: inputTokens / usableTokens,
    fits: inputTokens <= usableTokens,
  } };
}

/** Use a complete requestFill measurement. No latch, hysteresis or remembered trigger state. */
export function shouldRewrite(fill: RequestFill, options: Partial<CompactionOptions> = {}): boolean {
  const threshold = options.contextLimitRatio ?? DEFAULT_CONTEXT_LIMIT_RATIO;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new RangeError("contextLimitRatio must be in (0, 1].");
  return fill.ratio >= threshold;
}

/** Contracts for rewrite orchestration; defining outcomes does not execute or commit a rewrite. */
export type CompactionOutcome =
  /** Below the trigger; no state change. */
  | { status: "noop"; state: FrozenState; fill: RequestFill }
  /** A committed summary rewrite, with exactly one generation increment. */
  | { status: "rewritten"; state: FrozenState; fill: RequestFill }
  /** A stubs-only commit: one generation increment, existing summary/boundary preserved. */
  | { status: "stubbed"; state: FrozenState; fill: RequestFill }
  /** No useful change, but the unchanged request fits usable capacity. */
  | { status: "unchanged_fits"; state: FrozenState; fill: RequestFill }
  /** Summary failure/timeout; previous state retained and the unchanged request fits. */
  | { status: "summary_failed_fits"; state: FrozenState; fill: RequestFill; reason: string }
  /** Nothing committed; state is the previously restored state. */
  | { status: "cancelled"; state: FrozenState }
  /** Do not assume the previous state: reload raw events and restore before continuing. */
  | { status: "commit_uncertain"; error: unknown }
  | CapacityErrorOutcome;
