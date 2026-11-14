import { createHash } from "node:crypto";
import { CanonicalTranscriptError, CanonicalValidator, emitCanonicalTranscript, readCanonicalEntries, resolveRawEvents, type CanonicalEventSource, type CanonicalRecord } from "./canonical-transcript.js";
import {
  buildSameModelSummaryRequest,
  buildSummaryRepairRequest,
  cutDescription,
  nextBatchSummaryRequest,
  planBatchSummaries,
  summaryResponseHasToolCalls,
  type BatchSummaryAttempt,
  type SummaryResult,
} from "./compaction-requests.js";
import { findLastResetBoundaryIndex, type EventLog } from "./event-log.js";
import {
  appendCommit,
  buildSummaryInstruction,
  checkSummary,
  FrozenSummaryError,
  minimumValidSummary,
  renderSummaryMessage,
  restoreFrozenState,
  SESSION_START_EPOCH,
  summaryCapTokens,
  type CompactionCommit,
  type FrozenState,
  type SummaryInstructionOptions,
} from "./frozen-summary.js";
import type { ConversationMessage, ProviderUsage, StreamRequest, ToolDefinition } from "./llm/types.js";
import { estimateTokens } from "./token-estimate.js";
import type { StateObject } from "./types.js";

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

/** Emit one turn's messages; a terminal pending batch is not repaired, so only recorded messages are returned. */
function emitTurnMessages(records: readonly CanonicalRecord[]): ConversationMessage[] {
  const emittedCount = records.filter((record) => ["user_input", "wrap_up", "assistant", "tool_result"].includes(record.kind)).length;
  return emitCanonicalTranscript(records).slice(0, emittedCount);
}

/** A turn's records with the given stub texts substituted for their tool results (no mutation). */
function applyStubs(turn: CompactionTurn, stubs: ReadonlyMap<string, string>): CanonicalRecord[] {
  return turn.records.map((record, index): CanonicalRecord => {
    const replacement = stubs.get(turn.eventIds[index]);
    return record.kind === "tool_result" && replacement !== undefined
      ? { ...record, message: { ...record.message, text: replacement } }
      : record;
  });
}

function toStubSet(stubs: ReadonlyMap<string, string>): StubEntry[] {
  return Array.from(stubs, ([eventId, stubText]) => ({ eventId, stubText }));
}

function groupTurns(source: CanonicalEventSource): CompactionTurn[] {
  const turns: CompactionTurn[] = [];
  for (const { eventId, record } of readCanonicalEntries(source)) {
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

function turnView(source: CanonicalEventSource, options: { estimate?: boolean } = {}): CompactionTurn[] {
  const turns = groupTurns(source);
  const validator = new CanonicalValidator();
  for (const turn of turns) {
    for (const record of turn.records) validator.accept(record);
    turn.messages = emitTurnMessages(turn.records);
    if (options.estimate !== false) turn.estimatedTokens = turn.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  }
  return turns;
}

/** Current-epoch units in log order. Invalid sequences throw CanonicalTranscriptError. */
export function buildTurns(source: CanonicalEventSource, options: { estimate?: boolean } = {}): CompactionTurn[] {
  return turnView(source, options);
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
export function materializeHistory(state: FrozenState, source: CanonicalEventSource): MaterializationResult {
  try {
    const events = resolveRawEvents(source);
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
    const tail = turns.slice(cut + 1).flatMap((turn) => applyStubs(turn, stubs));
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

export type SummaryRequestMeta = NonNullable<FrozenState["summaryRequest"]>;

/**
 * An accepted, uncommitted summary. Its base identity is resetEpoch + baseBoundaryEventId +
 * previousSummarySha256 (null when there was no summary). Reuse requires that identity to match
 * the current frozen state and boundaryEventId to remain the intended cut. Generation is irrelevant:
 * stubs-only commits preserve this base.
 *
 * The text was produced from the live request and stateObjects as they stood when generated.
 * A reusing caller must run fresh fit and benefit checks against the CURRENT state and use the
 * normal commit path, never insert the cached text straight into a commit. No code in src/
 * consumes this field for reuse yet.
 */
export interface DiscardedSummary {
  boundaryEventId: string;
  resetEpoch: string;
  baseBoundaryEventId: string | null;
  previousSummarySha256: string | null;
  text: string;
  request: SummaryRequestMeta | null;
}

/** Values only: the integration layer must make terminal capacity stops exit headless runs non-zero. */
export interface CapacityErrorOutcome {
  status: "capacity_error";
  kind: CapacityErrorKind;
  message: string;
  summaryDiscarded?: true;
  discardedSummary?: DiscardedSummary;
}

export type RequestFillResult = { ok: true; fill: RequestFill } | { ok: false; error: CapacityErrorOutcome };

function withDiscardedSummary<T extends object>(
  outcome: T,
  discardedSummary?: DiscardedSummary,
): T & { summaryDiscarded?: true; discardedSummary?: DiscardedSummary } {
  return discardedSummary ? { ...outcome, summaryDiscarded: true, discardedSummary } : outcome;
}

function capacityError(
  kind: CapacityErrorKind,
  detail: string,
  discardedSummary?: DiscardedSummary,
): { ok: false; error: CapacityErrorOutcome } {
  const guidance = kind === "invalid_capacity"
    ? "Correct the configuration or model catalog entry before continuing."
    : "Use /clear or a larger-context model before continuing.";
  const error: CapacityErrorOutcome = {
    status: "capacity_error",
    kind,
    message: `${detail} ${guidance}`,
  };
  return { ok: false, error: withDiscardedSummary(error, discardedSummary) };
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

/**
 * fold_not_possible: the minimum summary cannot fit or the source cannot be folded.
 * fold_not_beneficial: a fold cannot shrink the request, even if it would fit.
 * fold_insufficient: an accepted fold still exceeds capacity after in-flight stubbing.
 * The remaining reasons distinguish missing eligible results from a declined stub plan.
 */
export type UnchangedFitsReason = "fold_not_possible" | "fold_not_beneficial" | "fold_insufficient" | "no_eligible_results" | "planner_declined";

/** Contracts for rewrite orchestration; defining outcomes does not execute or commit a rewrite. */
export type CompactionOutcome =
  /** Below the trigger; no state change. */
  | { status: "noop"; state: FrozenState; fill: RequestFill }
  /** A committed summary rewrite, with exactly one generation increment. */
  | { status: "rewritten"; state: FrozenState; fill: RequestFill }
  /** A stubs-only commit: one generation increment, existing summary/boundary preserved. */
  | { status: "stubbed"; state: FrozenState; fill: RequestFill; summaryDiscarded?: true; discardedSummary?: DiscardedSummary }
  /** No useful change, but the unchanged request fits; reason distinguishes impossible, unhelpful and oversized folds. */
  | { status: "unchanged_fits"; state: FrozenState; fill: RequestFill; reason: UnchangedFitsReason; summaryDiscarded?: true; discardedSummary?: DiscardedSummary }
  /** Summary failure/timeout; previous state retained and the unchanged request fits. */
  | { status: "summary_failed_fits"; state: FrozenState; fill: RequestFill; reason: string }
  /** Nothing committed by this run. State is pre-race; callers must re-restore from the log before continuing. */
  | { status: "cancelled"; state: FrozenState; reason: "aborted" | "superseded" | "reset" }
  /** Replay or commit validation rejected the rewrite before append; nothing committed. */
  | { status: "commit_rejected"; state: FrozenState; reason: string; error: FrozenSummaryError }
  /** Do not assume the previous state: reload raw events and restore before continuing. */
  | { status: "commit_uncertain"; error: unknown }
  | CapacityErrorOutcome;

export interface StubCandidate {
  eventId: string;
  turnId: number;
  callId: string;
  toolName: string;
  text: string;
  isError: boolean;
  estimatedTokens: number;
}

export interface StubEntry {
  eventId: string;
  stubText: string;
}

export type StubPlanner = (
  candidates: readonly StubCandidate[],
  options: { phase: "stale" | "in_flight"; minTokens: number; keepRecent: number },
) => readonly StubEntry[];

export type SummaryRunner = (
  request: StreamRequest,
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<SummaryResult>;

export interface RunCompactionInput {
  log: Pick<EventLog, "readAll" | "append">;
  liveRequest: StreamRequest;
  contextWindowTokens: number;
  frame?: RequestFrame;
  stateObjects?: readonly StateObject[];
  signal?: AbortSignal;
  options?: Partial<CompactionOptions>;
  planStubs?: StubPlanner;
  runSummary?: SummaryRunner;
  materialize?: (state: FrozenState, source: CanonicalEventSource) => MaterializationResult;
}

function defaultPlanStubs(candidates: readonly StubCandidate[]): readonly StubEntry[] {
  return candidates.map((c) => ({
    eventId: c.eventId,
    stubText: `[tool_result ${c.eventId} (${c.toolName}) stubbed]`,
  }));
}

function defaultRunSummary(): Promise<SummaryResult> {
  return Promise.reject(new Error("No summary runner supplied."));
}

function resolveOptions(options: Partial<CompactionOptions> = {}): CompactionOptions & { effectiveMaxTokens: number } {
  const contextLimitRatio = options.contextLimitRatio ?? DEFAULT_CONTEXT_LIMIT_RATIO;
  const postRewriteMargin = options.postRewriteMargin ?? DEFAULT_POST_REWRITE_MARGIN;
  const tailTurns = options.tailTurns ?? DEFAULT_TAIL_TURNS;
  const tokensReserve = options.tokensReserve ?? DEFAULT_TOKENS_RESERVE;
  const effectiveMaxTokens = options.effectiveMaxTokens ?? tokensReserve;
  const stubKeepRecent = options.stubKeepRecent ?? DEFAULT_STUB_KEEP_RECENT;
  const stubMinTokens = options.stubMinTokens ?? DEFAULT_STUB_MIN_TOKENS;
  const summaryTimeoutMs = options.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
  if (!Number.isFinite(contextLimitRatio) || contextLimitRatio <= 0 || contextLimitRatio > 1) {
    throw new RangeError("contextLimitRatio must be in (0, 1].");
  }
  if (!Number.isFinite(postRewriteMargin) || postRewriteMargin < 0 || postRewriteMargin >= contextLimitRatio) {
    throw new RangeError("postRewriteMargin must be in [0, contextLimitRatio).");
  }
  if (!Number.isSafeInteger(tailTurns) || tailTurns < 0) {
    throw new RangeError("tailTurns must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(stubKeepRecent) || stubKeepRecent < 1) {
    throw new RangeError("stubKeepRecent must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(stubMinTokens) || stubMinTokens < 0) {
    throw new RangeError("stubMinTokens must be a non-negative safe integer.");
  }
  if (!Number.isFinite(summaryTimeoutMs) || summaryTimeoutMs <= 0) {
    throw new RangeError("summaryTimeoutMs must be a positive finite number.");
  }
  return {
    contextLimitRatio,
    postRewriteMargin,
    tailTurns,
    tokensReserve,
    effectiveMaxTokens,
    stubKeepRecent,
    stubMinTokens,
    summaryTimeoutMs,
  };
}

function collectToolResults(turns: readonly CompactionTurn[]): StubCandidate[] {
  const results: StubCandidate[] = [];
  for (const turn of turns) {
    for (let i = 0; i < turn.records.length; i++) {
      const record = turn.records[i];
      if (record.kind !== "tool_result") continue;
      results.push({
        eventId: turn.eventIds[i],
        turnId: turn.turnId,
        callId: record.message.callId,
        toolName: record.message.toolName,
        text: record.message.text,
        isError: record.message.isError,
        estimatedTokens: estimateTokens(record.message.text),
      });
    }
  }
  return results;
}

function applyStubPlanner(
  planStubs: StubPlanner,
  candidates: readonly StubCandidate[],
  options: { phase: "stale" | "in_flight"; minTokens: number; keepRecent: number },
): StubEntry[] {
  if (!candidates.length) return [];
  const allowed = new Map(candidates.map((c) => [c.eventId, c]));
  const planned = planStubs(candidates, options);
  const seen = new Set<string>();
  const accepted: StubEntry[] = [];
  for (const entry of planned) {
    const candidate = allowed.get(entry.eventId);
    if (!candidate || seen.has(entry.eventId) || typeof entry.stubText !== "string") continue;
    if (estimateTokens(entry.stubText) > candidate.estimatedTokens) continue;
    seen.add(entry.eventId);
    accepted.push({ eventId: entry.eventId, stubText: entry.stubText });
  }
  return accepted;
}

function stateCacheKey(s: FrozenState): string {
  return JSON.stringify([
    s.resetEpoch,
    s.boundaryEventId,
    s.summary,
    [...s.stubSet]
      .map((entry) => [entry.eventId, entry.stubText])
      .sort((a, b) => {
        if (a[0] < b[0]) return -1;
        return a[0] > b[0] ? 1 : 0;
      }),
  ]);
}

function mergeUsage(usages: readonly (Partial<ProviderUsage> | null | undefined)[]): Partial<ProviderUsage> | null {
  const combined: Partial<ProviderUsage> = {};
  for (const usage of usages) {
    if (!usage || typeof usage !== "object") continue;
    for (const key of ["input", "output", "totalTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
      const val = usage[key];
      if (typeof val === "number" && val >= 0 && Number.isSafeInteger(Math.floor(val))) {
        combined[key] = (combined[key] ?? 0) + Math.floor(val);
      }
    }
  }
  return Object.keys(combined).length > 0 ? combined : null;
}

async function invokeSummarizer(
  runSummary: SummaryRunner,
  request: StreamRequest,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ status: "ok"; result: SummaryResult } | { status: "cancelled" } | { status: "failed"; reason: string }> {
  if (callerSignal?.aborted) return { status: "cancelled" };
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(new Error(timedOut ? "summary timed out" : "summary cancelled"));
    }, { once: true });
  });
  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const result = await Promise.race([
      runSummary({ ...request, signal: controller.signal }, { signal: controller.signal, timeoutMs }),
      abortPromise,
    ]);
    if (callerSignal?.aborted) return { status: "cancelled" };
    if (timedOut) return { status: "failed", reason: "summary timed out" };
    return { status: "ok", result };
  } catch (error) {
    if (callerSignal?.aborted) return { status: "cancelled" };
    if (timedOut) return { status: "failed", reason: "summary timed out" };
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function validateSummaryResult(
  result: SummaryResult,
  capTokens: number,
): { ok: true } | { ok: false; repairable: boolean; reason: string } {
  if (summaryResponseHasToolCalls(result) || result.finishReason === "tool_use") {
    return { ok: false, repairable: false, reason: "summary response contained tool calls" };
  }
  if (result.finishReason === "length") {
    return { ok: false, repairable: true, reason: "summary output was truncated" };
  }
  if (result.finishReason !== "stop") {
    return { ok: false, repairable: false, reason: `invalid summary finish reason: ${result.finishReason}` };
  }
  const checked = checkSummary(result.text, { capTokens });
  if (!checked.ok) {
    return {
      ok: false,
      repairable: true,
      reason: checked.failures.map((f) => f.message).join("; ") || "summary failed validation",
    };
  }
  return { ok: true };
}

function tryCommitRewrite(
  log: Pick<EventLog, "readAll" | "append">,
  initialState: FrozenState,
  commit: Omit<CompactionCommit, "prefix">,
  signal: AbortSignal | undefined,
):
  | { status: "committed"; state: FrozenState }
  | { status: "cancelled"; reason: "aborted" | "superseded" | "reset" }
  | { status: "commit_rejected"; state: FrozenState; reason: string; error: FrozenSummaryError }
  | { status: "commit_uncertain"; error: unknown } {
  if (signal?.aborted) return { status: "cancelled", reason: "aborted" };
  const appended = appendCommit(log, commit);
  if (appended.status === "commit_uncertain") return { status: "commit_uncertain", error: appended.error };
  if (appended.status === "rejected") {
    if (appended.error.eventIndex === appended.candidateEventIndex &&
        (appended.error.code === "invalid_generation" || appended.error.code === "invalid_epoch")) {
      return { status: "cancelled", reason: appended.error.code === "invalid_generation" ? "superseded" : "reset" };
    }
    return { status: "commit_rejected", state: initialState, reason: appended.error.message, error: appended.error };
  }
  return {
    status: "committed",
    state: {
      resetEpoch: commit.resetEpoch,
      generation: commit.generation,
      boundaryEventId: commit.boundaryEventId,
      summary: commit.summary,
      stubSet: commit.stubSet.map((s) => ({ ...s })),
      summaryRequest: commit.summaryRequest === null ? null : { ...commit.summaryRequest },
    },
  };
}

/**
 * Execute the four-step compaction ladder against the session event log:
 * 1. Stub stale tool results older than the tail in one batch.
 * 2. Choose the tail (in-flight turn + up to tailTurns completed turns, shrinking
 *    one completed turn at a time to 0) and fold everything before it once.
 * 3. Stub inside the in-flight turn (oldest large results first, keeping the most
 *    recent stubKeepRecent results, shrinking to 1 under hard capacity pressure;
 *    the newest result is never stubbed).
 * 4. Stop with capacity_error when the in-flight turn + frame cannot fit usable capacity.
 */
export async function runCompaction(input: RunCompactionInput): Promise<CompactionOutcome> {
  const signal = input.signal ?? input.liveRequest.signal;
  const rawOptions = input.options ?? {};
  const frame: RequestFrame = {
    systemPrompt: input.frame?.systemPrompt ?? input.liveRequest.systemPrompt,
    snapshot: input.frame?.snapshot,
    tools: input.frame?.tools ?? input.liveRequest.tools,
  };

  // Validate capacity and reserve before anything else.
  const preCheck = requestFill(frame, [], input.contextWindowTokens, rawOptions);
  if (!preCheck.ok) return preCheck.error;

  const opts = resolveOptions(rawOptions);
  const targetRatio = opts.contextLimitRatio - opts.postRewriteMargin;
  const planStubs = input.planStubs ?? defaultPlanStubs;
  let sawEligibleResults = false;
  const runSummary = input.runSummary ?? defaultRunSummary;
  const materialize = input.materialize ?? materializeHistory;

  const events = input.log.readAll({ includeInternal: true });
  const restored = restoreFrozenState(events);
  if (!restored.ok) throw restored.error;
  const state = restored.state;

  const initialMat = materialize(state, events);
  if (!initialMat.ok) throw initialMat.error;

  const initialMeasured = requestFill(frame, initialMat.messages, input.contextWindowTokens, opts);
  if (!initialMeasured.ok) return initialMeasured.error;
  const initialFill = initialMeasured.fill;

  if (signal?.aborted) return { status: "cancelled", state, reason: "aborted" };
  if (!shouldRewrite(initialFill, opts) && initialFill.fits) {
    return { status: "noop", state, fill: initialFill };
  }

  const allTurns = buildTurns(events, { estimate: false });
  const cutIndex = state.boundaryEventId === null
    ? -1
    : allTurns.findIndex((t) => t.completed && t.eventIds.at(-1) === state.boundaryEventId);
  const activeTurns = allTurns.slice(cutIndex + 1);

  const inFlightTurn = activeTurns.at(-1);
  if (!inFlightTurn) {
    if (initialFill.fits) return { status: "unchanged_fits", state, fill: initialFill, reason: "no_eligible_results" };
    return capacityError("request_exceeds_capacity", "The request frame and summary exceed usable context capacity.").error;
  }

  const completedTurns = activeTurns.slice(0, -1);
  const activeResultIds = new Set(collectToolResults(activeTurns).map((c) => c.eventId));

  // Existing stubs pointing into active (unfolded) turns.
  const baseActiveStubs = new Map<string, string>();
  for (const stub of state.stubSet) {
    if (activeResultIds.has(stub.eventId)) baseActiveStubs.set(stub.eventId, stub.stubText);
  }

  // Materialize each distinct (resetEpoch, boundaryEventId, summary, stubSet) state at most once per run:
  // Worst case: 1 initial + 1 Step 1 stale-stub + 1 fold-only + stubKeepRecent post-fold
  // stub states + stubKeepRecent unfolded fallback stub states = 3 + 2 * stubKeepRecent.
  // The pre-fold baseline reuses the initial or Step 1 measurement; the fallback starts there too.
  // Non-beneficial folds skip post-fold stubbing. The full bound is reached only when a useful fold
  // remains oversized after stubbing, then the unfolded fallback also exhausts its keepRecent steps.
  const measuredByState = new Map<string, RequestFill>([
    [stateCacheKey(state), initialFill],
    [stateCacheKey({ ...state, stubSet: toStubSet(baseActiveStubs) }), initialFill],
  ]);

  const measureCandidate = (candidateState: FrozenState): RequestFill => {
    const key = stateCacheKey(candidateState);
    const cached = measuredByState.get(key);
    if (cached) return cached;
    const mat = materialize(candidateState, events);
    if (!mat.ok) throw mat.error;
    const measured = requestFill(frame, mat.messages, input.contextWindowTokens, opts);
    if (!measured.ok) throw new Error(measured.error.message);
    measuredByState.set(key, measured.fill);
    return measured.fill;
  };

  // Helper to run Step 3 (in-flight turn stubbing) on top of a given boundary, summary, and initial stub map.
  const runInFlightStubbing = (
    boundaryEventId: string | null,
    summary: string | null,
    summaryRequest: FrozenState["summaryRequest"],
    startingStubs: ReadonlyMap<string, string>,
  ): { cancelled: true } | { cancelled: false; stubSet: StubEntry[]; fill: RequestFill; changed: boolean } => {
    const stubMap = new Map(startingStubs);
    const inFlightCandidates = collectToolResults([inFlightTurn]);
    const buildState = (): FrozenState => ({
      resetEpoch: state.resetEpoch,
      generation: state.generation + 1,
      boundaryEventId,
      summary,
      stubSet: toStubSet(stubMap),
      summaryRequest,
    });
    let currentFill = measureCandidate(buildState());
    if (inFlightCandidates.length <= 1) {
      return {
        cancelled: false,
        stubSet: toStubSet(stubMap),
        fill: currentFill,
        changed: stubMap.size !== startingStubs.size,
      };
    }

    const startKeep = Math.max(1, opts.stubKeepRecent);
    let changed = false;
    for (let keepRecent = startKeep; keepRecent >= 1; keepRecent--) {
      const olderSlice = inFlightCandidates.slice(0, Math.max(0, inFlightCandidates.length - keepRecent));
      const eligible = olderSlice.filter((c) => !stubMap.has(c.eventId) && c.estimatedTokens >= opts.stubMinTokens);
      if (eligible.length > 0) {
        sawEligibleResults = true;
        if (signal?.aborted) return { cancelled: true };
        const planned = applyStubPlanner(planStubs, eligible, {
          phase: "in_flight",
          minTokens: opts.stubMinTokens,
          keepRecent,
        });
        if (signal?.aborted) return { cancelled: true };
        let stepChanged = false;
        for (const entry of planned) {
          if (stubMap.get(entry.eventId) !== entry.stubText) {
            stubMap.set(entry.eventId, entry.stubText);
            changed = true;
            stepChanged = true;
          }
        }
        if (stepChanged) currentFill = measureCandidate(buildState());
      }
      // Keep the most recent stubKeepRecent results verbatim whenever that already fits usable capacity;
      // only shrink keepRecent toward 1 under hard capacity pressure (!currentFill.fits).
      if (currentFill.fits) break;
    }

    return {
      cancelled: false,
      stubSet: toStubSet(stubMap),
      fill: currentFill,
      changed,
    };
  };

  // --- STEP 1: Stub stale tool results older than the tail in one batch ---
  const staleTurns = completedTurns.slice(0, Math.max(0, completedTurns.length - opts.tailTurns));
  const step1StubMap = new Map(baseActiveStubs);
  let step1AddedStubs = false;
  if (staleTurns.length > 0) {
    const staleEligible = collectToolResults(staleTurns).filter(
      (c) => !step1StubMap.has(c.eventId) && c.estimatedTokens >= opts.stubMinTokens,
    );
    if (staleEligible.length > 0) {
      sawEligibleResults = true;
      if (signal?.aborted) return { status: "cancelled", state, reason: "aborted" };
      const plannedStale = applyStubPlanner(planStubs, staleEligible, {
        phase: "stale",
        minTokens: opts.stubMinTokens,
        keepRecent: opts.stubKeepRecent,
      });
      if (signal?.aborted) return { status: "cancelled", state, reason: "aborted" };
      for (const entry of plannedStale) {
        if (step1StubMap.get(entry.eventId) !== entry.stubText) {
          step1StubMap.set(entry.eventId, entry.stubText);
          step1AddedStubs = true;
        }
      }
    }
  }

  if (step1AddedStubs) {
    const step1StubSet = toStubSet(step1StubMap);
    const step1Candidate: FrozenState = {
      resetEpoch: state.resetEpoch,
      generation: state.generation + 1,
      boundaryEventId: state.boundaryEventId,
      summary: state.summary,
      stubSet: step1StubSet,
      summaryRequest: null,
    };
    const step1Fill = measureCandidate(step1Candidate);
    if (step1Fill.fits && step1Fill.ratio <= targetRatio) {
      const committed = tryCommitRewrite(
        input.log,
        state,
        { formatVersion: 1, ...step1Candidate },
        signal,
      );
      if (committed.status === "cancelled") return { ...committed, state };
      if (committed.status === "commit_rejected" || committed.status === "commit_uncertain") return committed;
      return { status: "stubbed", state: committed.state, fill: step1Fill };
    }
  }

  // --- STEP 2: Choose the tail, then fold once (only when completedTurns.length > 0) ---
  let summaryFailureReason: string | undefined;
  let unchangedReason: UnchangedFitsReason | undefined;
  let discardedSummary: DiscardedSummary | undefined;

  if (completedTurns.length > 0) {
    const capTokens = summaryCapTokens(initialFill.usableTokens);
    const minValidSummary = minimumValidSummary();
    const minValidSummaryTokens = estimateTokens(minValidSummary);
    const minSummaryMessageTokens = estimateMessageTokens(renderSummaryMessage(minValidSummary));
    const summaryAllowanceTokens = estimateMessageTokens(renderSummaryMessage("")) + capTokens;

    // Pre-check whether the in-flight turn (after maximal Step 3 stubbing down to keepRecent=1) + frame + minimum valid summary can fit usable capacity.
    const inFlightMinMap = new Map(step1StubMap);
    const inFlightCandidates = collectToolResults([inFlightTurn]);
    const unstubbedInFlightMessages = emitCanonicalTranscript(applyStubs(inFlightTurn, inFlightMinMap));
    // Frame + shortest tail + minimum valid summary, after Step 1 but without new in-flight stubs: benefit baseline.
    const foldAloneBestCase = estimateRequestTokens(frame, unstubbedInFlightMessages) + minSummaryMessageTokens;
    // The same request with maximal in-flight stubbing (keepRecent=1): capacity lower bound.
    let stubbedFoldBestCase = foldAloneBestCase;
    if (stubbedFoldBestCase > initialFill.usableTokens && inFlightCandidates.length > 1) {
      const eligibleOldInFlight = inFlightCandidates
        .slice(0, -1)
        .filter((c) => !inFlightMinMap.has(c.eventId) && c.estimatedTokens >= opts.stubMinTokens);
      if (eligibleOldInFlight.length > 0) {
        sawEligibleResults = true;
        if (signal?.aborted) return { status: "cancelled", state, reason: "aborted" };
        const plannedMin = applyStubPlanner(planStubs, eligibleOldInFlight, {
          phase: "in_flight",
          minTokens: opts.stubMinTokens,
          keepRecent: 1,
        });
        if (signal?.aborted) return { status: "cancelled", state, reason: "aborted" };
        for (const entry of plannedMin) inFlightMinMap.set(entry.eventId, entry.stubText);
        const inFlightMinMessages = emitCanonicalTranscript(applyStubs(inFlightTurn, inFlightMinMap));
        stubbedFoldBestCase = estimateRequestTokens(frame, inFlightMinMessages) + minSummaryMessageTokens;
      }
    }

    // Necessary-condition filter: even the shortest tail and minimum valid summary must beat the request after Step 1.
    // A realistic summary is larger, so a paid summary can still be discarded by the commit rule;
    // this only avoids clearly hopeless folds, not every unhelpful summary call.
    const foldNotPossible = capTokens < minValidSummaryTokens || stubbedFoldBestCase > initialFill.usableTokens;
    // Reuse the request measured after Step 1, only after the cheap impossibility checks.
    // unchanged_fits returns the original state unless the Step 3 fallback commits the stubs.
    const preFold = foldNotPossible ? null : measureCandidate({ ...state, stubSet: toStubSet(step1StubMap) });
    if (preFold === null) {
      unchangedReason = "fold_not_possible";
    } else if (foldAloneBestCase >= preFold.inputTokens) {
      unchangedReason = "fold_not_beneficial";
    } else {
      // Shrink completed turns in the tail from Math.min(tailTurns, completedTurns.length) down to 0
      // until frame + summary allowance + tail fits the target.
      let chosenKeepCompleted = 0;
      const maxKeep = Math.min(opts.tailTurns, completedTurns.length);
      for (let keep = maxKeep; keep >= 0; keep--) {
        const foldedCount = completedTurns.length - keep;
        if (foldedCount <= 0) continue;
        const tailSlice = [...completedTurns.slice(foldedCount), inFlightTurn];
        const tailRecords = tailSlice.flatMap((turn) => applyStubs(turn, baseActiveStubs));
        const tailMessages = emitCanonicalTranscript(tailRecords);
        const prospectiveTokens = estimateRequestTokens(frame, tailMessages) + summaryAllowanceTokens;
        if (prospectiveTokens <= initialFill.usableTokens && prospectiveTokens / initialFill.usableTokens <= targetRatio) {
          chosenKeepCompleted = keep;
          break;
        }
      }

      const foldedCount = completedTurns.length - chosenKeepCompleted;
      const foldedTurns = completedTurns.slice(0, foldedCount).map((turn): CompactionTurn => {
        const records = applyStubs(turn, step1StubMap);
        return { ...turn, records, messages: emitTurnMessages(records) };
      });
      const retainedTurns = [...completedTurns.slice(foldedCount), inFlightTurn];
      const lastFoldedTurn = foldedTurns.at(-1);
      const newBoundaryEventId = lastFoldedTurn?.eventIds.at(-1);
      if (!lastFoldedTurn || !newBoundaryEventId) {
        throw new Error("Expected at least one folded turn with a boundary event id.");
      }
      const cutText = cutDescription(lastFoldedTurn);

      // Drop any stubs pointing into foldedTurns; retain only stubs in retainedTurns.
      const retainedResultIds = new Set(collectToolResults(retainedTurns).map((c) => c.eventId));
      const retainedStubMap = new Map<string, string>();
      for (const [eid, text] of baseActiveStubs) {
        if (retainedResultIds.has(eid)) retainedStubMap.set(eid, text);
      }

      // Build and run the summary request (same-model if it fits, else batch fallback).
      const liveMessages = input.liveRequest.messages.length > 0 ? input.liveRequest.messages : initialMat.messages;
      const liveForSummary: StreamRequest = { ...input.liveRequest, messages: liveMessages };
      const instructionOptions: SummaryInstructionOptions = {
        cutDescription: cutText,
        capTokens,
      };
      if (state.summary !== null) instructionOptions.previousSummary = state.summary;
      if (input.stateObjects !== undefined) instructionOptions.stateObjects = input.stateObjects;
      const instruction = buildSummaryInstruction(instructionOptions);
      let instructionSha256 = createHash("sha256").update(instruction).digest("hex");
      const sameModelReq = buildSameModelSummaryRequest(liveForSummary, instruction);
      const sameModelFill = requestFill(frame, sameModelReq.messages, input.contextWindowTokens, opts);
      if (!sameModelFill.ok) return sameModelFill.error;

      let acceptedSummary: string | undefined;
      let acceptedUsage: Partial<ProviderUsage> | null = null;

      if (sameModelFill.fill.fits) {
        const primaryCall = await invokeSummarizer(runSummary, sameModelReq, signal, opts.summaryTimeoutMs);
        if (primaryCall.status === "cancelled") return { status: "cancelled", state, reason: "aborted" };
        if (primaryCall.status === "failed") {
          summaryFailureReason = primaryCall.reason;
        } else {
          const check = validateSummaryResult(primaryCall.result, capTokens);
          if (check.ok) {
            acceptedSummary = primaryCall.result.text;
            acceptedUsage = mergeUsage([primaryCall.result.usage]);
          } else if (!check.repairable) {
            summaryFailureReason = check.reason;
          } else {
            const repairBuilt = buildSummaryRepairRequest(sameModelReq, primaryCall.result, {
              capTokens,
              contextWindowTokens: input.contextWindowTokens,
              effectiveMaxTokens: opts.effectiveMaxTokens,
              attempt: 0,
            });
            if (repairBuilt.status === "capacity_error") return repairBuilt;
            if (repairBuilt.status !== "repair") {
              summaryFailureReason = check.reason;
            } else {
              const repairFrameFill = requestFill(frame, repairBuilt.request.messages, input.contextWindowTokens, opts);
              if (!repairFrameFill.ok) return repairFrameFill.error;
              if (!repairFrameFill.fill.fits) {
                summaryFailureReason = "summary repair request exceeds capacity";
              } else {
                const repairCall = await invokeSummarizer(runSummary, repairBuilt.request, signal, opts.summaryTimeoutMs);
                if (repairCall.status === "cancelled") return { status: "cancelled", state, reason: "aborted" };
                if (repairCall.status === "failed") {
                  summaryFailureReason = repairCall.reason;
                } else {
                  const repairCheck = validateSummaryResult(repairCall.result, capTokens);
                  if (repairCheck.ok) {
                    acceptedSummary = repairCall.result.text;
                    acceptedUsage = mergeUsage([primaryCall.result.usage, repairCall.result.usage]);
                  } else {
                    summaryFailureReason = repairCheck.reason;
                  }
                }
              }
            }
          }
        }
      } else {
        // Fallback: chained batch summaries.
        const planned = planBatchSummaries(liveForSummary, foldedTurns, {
          ...instructionOptions,
          contextWindowTokens: input.contextWindowTokens,
          effectiveMaxTokens: opts.effectiveMaxTokens,
        });
        if (planned.status === "capacity_error") return planned;
        if (planned.status === "not_foldable") {
          unchangedReason = "fold_not_possible";
        } else {
          const attempts: BatchSummaryAttempt[] = [];
          const usages: (Partial<ProviderUsage> | null | undefined)[] = [];
          while (true) {
            const step = nextBatchSummaryRequest(planned.plan, attempts);
            if (step.status === "capacity_error") return step;
            if (step.status === "failed") {
              summaryFailureReason = `batch summary failed (${step.reason})`;
              break;
            }
            if (step.status === "complete") {
              acceptedSummary = step.summary;
              acceptedUsage = mergeUsage(usages);
              break;
            }
            if (step.attempt === 0) {
              const lastMsg = step.request.messages.at(-1);
              if (lastMsg && lastMsg.role !== "tool_result" && typeof lastMsg.content === "string") {
                instructionSha256 = createHash("sha256").update(lastMsg.content).digest("hex");
              }
            }
            const call = await invokeSummarizer(runSummary, step.request, signal, opts.summaryTimeoutMs);
            if (call.status === "cancelled") return { status: "cancelled", state, reason: "aborted" };
            if (call.status === "failed") {
              summaryFailureReason = call.reason;
              break;
            }
            usages.push(call.result.usage);
            if (step.attempt === 0) {
              attempts.push({ result: call.result });
            } else {
              attempts[step.batchIndex] = { ...attempts[step.batchIndex], repair: call.result };
            }
          }
        }
      }

      if (acceptedSummary !== undefined) {
        const summaryRequestMeta: SummaryRequestMeta = {
          cutDescription: cutText,
          capTokens,
          instructionSha256,
          usage: acceptedUsage,
        };
        let finalStubSet = toStubSet(retainedStubMap);
        let postFoldState: FrozenState = {
          resetEpoch: state.resetEpoch,
          generation: state.generation + 1,
          boundaryEventId: newBoundaryEventId,
          summary: acceptedSummary,
          stubSet: finalStubSet,
          summaryRequest: summaryRequestMeta,
        };
        const foldOnlyFill = measureCandidate(postFoldState);
        const foldBeneficial = foldOnlyFill.inputTokens < preFold.inputTokens;
        let postFoldFill = foldOnlyFill;

        // Only spend Step 3 work on a fold that can be committed and has not reached the target.
        if (foldBeneficial && (!postFoldFill.fits || postFoldFill.ratio > targetRatio)) {
          const inFlightStubbed = runInFlightStubbing(
            newBoundaryEventId,
            acceptedSummary,
            summaryRequestMeta,
            retainedStubMap,
          );
          if (inFlightStubbed.cancelled) return { status: "cancelled", state, reason: "aborted" };
          finalStubSet = inFlightStubbed.stubSet;
          postFoldFill = inFlightStubbed.fill;
          postFoldState = { ...postFoldState, stubSet: finalStubSet };
        }

        if (postFoldFill.fits && foldBeneficial) {
          const committed = tryCommitRewrite(
            input.log,
            state,
            { formatVersion: 1, ...postFoldState },
            signal,
          );
          if (committed.status === "cancelled") return { ...committed, state };
          if (committed.status === "commit_rejected" || committed.status === "commit_uncertain") return committed;
          return { status: "rewritten", state: committed.state, fill: postFoldFill };
        }
        discardedSummary = {
          boundaryEventId: newBoundaryEventId,
          resetEpoch: state.resetEpoch,
          baseBoundaryEventId: state.boundaryEventId,
          previousSummarySha256: state.summary === null ? null : createHash("sha256").update(state.summary).digest("hex"),
          text: acceptedSummary,
          request: summaryRequestMeta,
        };
        unchangedReason = foldBeneficial ? "fold_insufficient" : "fold_not_beneficial";
      }
    }
  }

  // If summary failed and the unmodified request already fits usable capacity, keep the previous state and commit nothing.
  if (summaryFailureReason !== undefined && initialFill.fits) {
    return { status: "summary_failed_fits", state, fill: initialFill, reason: summaryFailureReason };
  }

  // --- STEP 3: Stub inside the in-flight turn (first-turn overflow, not_foldable fallback, or summary-failure rescue when !initialFill.fits) ---
  const step3Result = runInFlightStubbing(state.boundaryEventId, state.summary, null, step1StubMap);
  if (step3Result.cancelled) return { status: "cancelled", state, reason: "aborted" };
  const stubsChanged = step1AddedStubs || step3Result.changed;

  if (stubsChanged && step3Result.fill.fits) {
    const stubCommit: Omit<CompactionCommit, "prefix"> = {
      formatVersion: 1,
      resetEpoch: state.resetEpoch,
      generation: state.generation + 1,
      boundaryEventId: state.boundaryEventId,
      summary: state.summary,
      stubSet: step3Result.stubSet,
      summaryRequest: null,
    };
    const committed = tryCommitRewrite(input.log, state, stubCommit, signal);
    if (committed.status === "cancelled") return { ...committed, state };
    if (committed.status === "commit_rejected" || committed.status === "commit_uncertain") return committed;
    const outcome: CompactionOutcome = {
      status: "stubbed",
      state: committed.state,
      fill: step3Result.fill,
    };
    return withDiscardedSummary(outcome, discardedSummary);
  }

  // --- STEP 4: Unchanged fits or terminal capacity error ---
  if (initialFill.fits) {
    const outcome: CompactionOutcome = {
      status: "unchanged_fits",
      state,
      fill: initialFill,
      reason: unchangedReason ?? (sawEligibleResults ? "planner_declined" : "no_eligible_results"),
    };
    return withDiscardedSummary(outcome, discardedSummary);
  }

  return capacityError(
    "request_exceeds_capacity",
    summaryFailureReason
      ? `Summary generation failed (${summaryFailureReason}) and the request exceeds usable context capacity.`
      : "The in-flight turn and request frame exceed usable context capacity.",
    discardedSummary,
  ).error;
}
