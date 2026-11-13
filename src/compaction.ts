import { createHash } from "node:crypto";
import { CanonicalTranscriptError, CanonicalValidator, emitCanonicalTranscript, readCanonicalEntries, type CanonicalEventSource, type CanonicalRecord } from "./canonical-transcript.js";
import {
  buildSameModelSummaryRequest,
  buildSummaryRepairRequest,
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
  renderSummaryMessage,
  restoreFrozenState,
  SESSION_START_EPOCH,
  SUMMARY_HEADINGS,
  summaryCapTokens,
  type CompactionCommit,
  type FrozenState,
} from "./frozen-summary.js";
import type { ConversationMessage, ProviderUsage, StreamRequest, ToolDefinition } from "./llm/types.js";
import { estimateTokens } from "./token-estimate.js";
import type { Event, StateObject } from "./types.js";

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

function resolveRawEvents(source: CanonicalEventSource): readonly Event[] {
  return "readAll" in source ? source.readAll({ includeInternal: true }) : source;
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
    const emittedCount = turn.records.filter((record) => ["user_input", "wrap_up", "assistant", "tool_result"].includes(record.kind)).length;
    // The strict emitter repairs a terminal pending batch; estimates cover recorded bytes only.
    turn.messages = emitCanonicalTranscript(turn.records).slice(0, emittedCount);
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

function capacityError(kind: CapacityErrorKind, detail: string): { ok: false; error: CapacityErrorOutcome } {
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
): { status: "committed"; state: FrozenState } | { status: "cancelled" } | { status: "commit_uncertain"; error: unknown } {
  if (signal?.aborted) return { status: "cancelled" };
  const latestEvents = log.readAll({ includeInternal: true });
  const resetIdx = findLastResetBoundaryIndex([...latestEvents]);
  const latestEpoch = resetIdx < 0 ? SESSION_START_EPOCH : latestEvents[resetIdx].event_id;
  if (latestEpoch !== initialState.resetEpoch) return { status: "cancelled" };
  const latestRestored = restoreFrozenState(latestEvents);
  if (!latestRestored.ok || latestRestored.state.generation !== initialState.generation) {
    return { status: "cancelled" };
  }
  const appended = appendCommit(log, commit);
  if (appended.status === "commit_uncertain") return { status: "commit_uncertain", error: appended.error };
  if (appended.status === "rejected") return { status: "cancelled" };
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
  const runSummary = input.runSummary ?? defaultRunSummary;

  const events = input.log.readAll({ includeInternal: true });
  const restored = restoreFrozenState(events);
  if (!restored.ok) throw restored.error;
  const state = restored.state;

  const initialMat = materializeHistory(state, events);
  if (!initialMat.ok) throw initialMat.error;

  const initialMeasured = requestFill(frame, initialMat.messages, input.contextWindowTokens, opts);
  if (!initialMeasured.ok) return initialMeasured.error;
  const initialFill = initialMeasured.fill;

  if (signal?.aborted) return { status: "cancelled", state };
  if (!shouldRewrite(initialFill, opts) && initialFill.fits) {
    return { status: "noop", state, fill: initialFill };
  }

  const allTurns = buildTurns(events);
  const cutIndex = state.boundaryEventId === null
    ? -1
    : allTurns.findIndex((t) => t.completed && t.eventIds.at(-1) === state.boundaryEventId);
  const activeTurns = allTurns.slice(cutIndex + 1);

  if (activeTurns.length === 0) {
    if (initialFill.fits) return { status: "unchanged_fits", state, fill: initialFill };
    return capacityError("request_exceeds_capacity", "The request frame and summary exceed usable context capacity.").error;
  }

  const completedTurns = activeTurns.slice(0, -1);
  const inFlightTurn = activeTurns.at(-1)!;
  const activeResultIds = new Set(collectToolResults(activeTurns).map((c) => c.eventId));

  // Existing stubs pointing into active (unfolded) turns.
  const baseActiveStubs = new Map<string, string>();
  for (const stub of state.stubSet) {
    if (activeResultIds.has(stub.eventId)) baseActiveStubs.set(stub.eventId, stub.stubText);
  }

  const measureCandidate = (candidateState: FrozenState): RequestFill => {
    const mat = materializeHistory(candidateState, events);
    if (!mat.ok) throw mat.error;
    const measured = requestFill(frame, mat.messages, input.contextWindowTokens, opts);
    if (!measured.ok) throw new Error(measured.error.message);
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
      stubSet: Array.from(stubMap, ([eventId, stubText]) => ({ eventId, stubText })),
      summaryRequest,
    });
    let currentFill = measureCandidate(buildState());
    if (inFlightCandidates.length <= 1) {
      return {
        cancelled: false,
        stubSet: Array.from(stubMap, ([eventId, stubText]) => ({ eventId, stubText })),
        fill: currentFill,
        changed: stubMap.size !== startingStubs.size,
      };
    }

    const startKeep = Math.min(Math.max(1, opts.stubKeepRecent), inFlightCandidates.length - 1);
    let changed = false;
    for (let keepRecent = startKeep; keepRecent >= 1; keepRecent--) {
      const olderSlice = inFlightCandidates.slice(0, inFlightCandidates.length - keepRecent);
      const eligible = olderSlice.filter((c) => !stubMap.has(c.eventId) && c.estimatedTokens >= opts.stubMinTokens);
      if (eligible.length > 0) {
        if (signal?.aborted) return { cancelled: true };
        const planned = applyStubPlanner(planStubs, eligible, {
          phase: "in_flight",
          minTokens: opts.stubMinTokens,
          keepRecent,
        });
        if (signal?.aborted) return { cancelled: true };
        for (const entry of planned) {
          if (stubMap.get(entry.eventId) !== entry.stubText) {
            stubMap.set(entry.eventId, entry.stubText);
            changed = true;
          }
        }
        currentFill = measureCandidate(buildState());
      }
      // Keep the most recent stubKeepRecent results verbatim whenever that already fits usable capacity;
      // only shrink keepRecent toward 1 under hard capacity pressure (!currentFill.fits).
      if (currentFill.fits) break;
    }

    return {
      cancelled: false,
      stubSet: Array.from(stubMap, ([eventId, stubText]) => ({ eventId, stubText })),
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
      if (signal?.aborted) return { status: "cancelled", state };
      const plannedStale = applyStubPlanner(planStubs, staleEligible, {
        phase: "stale",
        minTokens: opts.stubMinTokens,
        keepRecent: opts.stubKeepRecent,
      });
      if (signal?.aborted) return { status: "cancelled", state };
      for (const entry of plannedStale) {
        if (step1StubMap.get(entry.eventId) !== entry.stubText) {
          step1StubMap.set(entry.eventId, entry.stubText);
          step1AddedStubs = true;
        }
      }
    }
  }

  if (step1AddedStubs) {
    const step1StubSet = Array.from(step1StubMap, ([eventId, stubText]) => ({ eventId, stubText }));
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
      if (committed.status === "cancelled") return { status: "cancelled", state };
      if (committed.status === "commit_uncertain") return committed;
      return { status: "stubbed", state: committed.state, fill: step1Fill };
    }
  }

  // --- STEP 2: Choose the tail, then fold once (only when completedTurns.length > 0) ---
  let summaryFailureReason: string | undefined;
  let foldNotPossible = false;

  if (completedTurns.length > 0) {
    const capTokens = summaryCapTokens(initialFill.usableTokens);
    const minValidSummaryTokens = estimateTokens(SUMMARY_HEADINGS.map((h) => `### ${h}`).join("\n\n") + "\nok");
    const summaryAllowanceTokens = estimateMessageTokens(renderSummaryMessage("")) + capTokens;

    // Pre-check Step 4 bound: can the in-flight turn (even after maximum Step 3 stubbing) + frame + summary allowance fit usable capacity?
    const maxStubbedInFlight = runInFlightStubbing(state.boundaryEventId, state.summary, null, new Map());
    if (maxStubbedInFlight.cancelled) return { status: "cancelled", state };

    const inFlightMinMap = new Map(maxStubbedInFlight.stubSet.map((s) => [s.eventId, s.stubText]));
    const inFlightMinRecords = inFlightTurn.records.map((record, idx): CanonicalRecord => {
      const eid = inFlightTurn.eventIds[idx];
      return record.kind === "tool_result" && inFlightMinMap.has(eid)
        ? { ...record, message: { ...record.message, text: inFlightMinMap.get(eid)! } }
        : record;
    });
    const inFlightMinMessages = emitCanonicalTranscript(inFlightMinRecords);
    const minTailTokensWithAllowance = estimateRequestTokens(frame, inFlightMinMessages) + summaryAllowanceTokens;

    if (capTokens < minValidSummaryTokens || minTailTokensWithAllowance > initialFill.usableTokens) {
      foldNotPossible = true;
    } else {
      // Shrink completed turns in the tail from Math.min(tailTurns, completedTurns.length) down to 0
      // until frame + summary allowance + tail fits the target.
      let chosenKeepCompleted = 0;
      const maxKeep = Math.min(opts.tailTurns, completedTurns.length);
      for (let keep = maxKeep; keep >= 0; keep--) {
        const foldedCount = completedTurns.length - keep;
        if (foldedCount <= 0) continue;
        const tailSlice = [...completedTurns.slice(foldedCount), inFlightTurn];
        const tailRecords = tailSlice.flatMap((turn) =>
          turn.records.map((record, idx): CanonicalRecord => {
            const eid = turn.eventIds[idx];
            return record.kind === "tool_result" && baseActiveStubs.has(eid)
              ? { ...record, message: { ...record.message, text: baseActiveStubs.get(eid)! } }
              : record;
          }),
        );
        const tailMessages = emitCanonicalTranscript(tailRecords);
        const prospectiveTokens = estimateRequestTokens(frame, tailMessages) + summaryAllowanceTokens;
        if (prospectiveTokens <= initialFill.usableTokens && prospectiveTokens / initialFill.usableTokens <= targetRatio) {
          chosenKeepCompleted = keep;
          break;
        }
      }

      const foldedCount = completedTurns.length - chosenKeepCompleted;
      const foldedTurns = completedTurns.slice(0, foldedCount).map((turn): CompactionTurn => {
        const records = turn.records.map((record, idx): CanonicalRecord => {
          const eid = turn.eventIds[idx];
          return record.kind === "tool_result" && step1StubMap.has(eid)
            ? { ...record, message: { ...record.message, text: step1StubMap.get(eid)! } }
            : record;
        });
        const emittedCount = records.filter((r) => ["user_input", "wrap_up", "assistant", "tool_result"].includes(r.kind)).length;
        return { ...turn, records, messages: emitCanonicalTranscript(records).slice(0, emittedCount) };
      });
      const retainedTurns = [...completedTurns.slice(foldedCount), inFlightTurn];
      const newBoundaryEventId = foldedTurns.at(-1)!.eventIds.at(-1)!;
      const cutDescription = `through canonical event ${newBoundaryEventId} (end of turn ${foldedTurns.at(-1)!.turnId})`;

      // Drop any stubs pointing into foldedTurns; retain only stubs in retainedTurns.
      const retainedResultIds = new Set(collectToolResults(retainedTurns).map((c) => c.eventId));
      const retainedStubMap = new Map<string, string>();
      for (const [eid, text] of baseActiveStubs) {
        if (retainedResultIds.has(eid)) retainedStubMap.set(eid, text);
      }

      // Build and run the summary request (same-model if it fits, else batch fallback).
      const liveMessages = input.liveRequest.messages.length > 0 ? input.liveRequest.messages : initialMat.messages;
      const liveForSummary: StreamRequest = { ...input.liveRequest, messages: liveMessages };
      const instructionOptions = {
        cutDescription,
        capTokens,
        ...(state.summary !== null ? { previousSummary: state.summary } : {}),
        ...(input.stateObjects !== undefined ? { stateObjects: input.stateObjects } : {}),
      };
      const instruction = buildSummaryInstruction(instructionOptions);
      let instructionSha256 = createHash("sha256").update(instruction).digest("hex");
      const sameModelReq = buildSameModelSummaryRequest(liveForSummary, instruction);
      const sameModelFill = requestFill(frame, sameModelReq.messages, input.contextWindowTokens, opts);
      if (!sameModelFill.ok) return sameModelFill.error;

      let acceptedSummary: string | undefined;
      let acceptedUsage: Partial<ProviderUsage> | null = null;

      if (sameModelFill.fill.fits) {
        const primaryCall = await invokeSummarizer(runSummary, sameModelReq, signal, opts.summaryTimeoutMs);
        if (primaryCall.status === "cancelled") return { status: "cancelled", state };
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
                if (repairCall.status === "cancelled") return { status: "cancelled", state };
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
          foldNotPossible = true;
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
            if (call.status === "cancelled") return { status: "cancelled", state };
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
        const summaryRequestMeta: NonNullable<FrozenState["summaryRequest"]> = {
          cutDescription,
          capTokens,
          instructionSha256,
          usage: acceptedUsage,
        };
        let finalStubSet = Array.from(retainedStubMap, ([eventId, stubText]) => ({ eventId, stubText }));
        let postFoldState: FrozenState = {
          resetEpoch: state.resetEpoch,
          generation: state.generation + 1,
          boundaryEventId: newBoundaryEventId,
          summary: acceptedSummary,
          stubSet: finalStubSet,
          summaryRequest: summaryRequestMeta,
        };
        let postFoldFill = measureCandidate(postFoldState);

        // If folding alone did not reach the target, run Step 3 (stub inside the in-flight turn).
        if (!postFoldFill.fits || postFoldFill.ratio > targetRatio) {
          const inFlightStubbed = runInFlightStubbing(
            newBoundaryEventId,
            acceptedSummary,
            summaryRequestMeta,
            retainedStubMap,
          );
          if (inFlightStubbed.cancelled) return { status: "cancelled", state };
          finalStubSet = inFlightStubbed.stubSet;
          postFoldFill = inFlightStubbed.fill;
          postFoldState = { ...postFoldState, stubSet: finalStubSet };
        }

        if (!postFoldFill.fits) {
          return capacityError("request_exceeds_capacity", "The in-flight turn exceeds usable context capacity even after folding and stubbing.").error;
        }

        const committed = tryCommitRewrite(
          input.log,
          state,
          { formatVersion: 1, ...postFoldState },
          signal,
        );
        if (committed.status === "cancelled") return { status: "cancelled", state };
        if (committed.status === "commit_uncertain") return committed;
        return { status: "rewritten", state: committed.state, fill: postFoldFill };
      }
    }
  }

  // If summary failed and the unmodified request already fits usable capacity, keep the previous state and commit nothing.
  if (summaryFailureReason !== undefined && initialFill.fits) {
    return { status: "summary_failed_fits", state, fill: initialFill, reason: summaryFailureReason };
  }

  // --- STEP 3: Stub inside the in-flight turn (first-turn overflow, not_foldable fallback, or summary-failure rescue when !initialFill.fits) ---
  const step3Result = runInFlightStubbing(state.boundaryEventId, state.summary, null, step1StubMap);
  if (step3Result.cancelled) return { status: "cancelled", state };
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
    if (committed.status === "cancelled") return { status: "cancelled", state };
    if (committed.status === "commit_uncertain") return committed;
    return { status: "stubbed", state: committed.state, fill: step3Result.fill };
  }

  // --- STEP 4: Unchanged fits or terminal capacity error ---
  if (initialFill.fits && !foldNotPossible) {
    return { status: "unchanged_fits", state, fill: initialFill };
  }

  return capacityError(
    "request_exceeds_capacity",
    summaryFailureReason
      ? `Summary generation failed (${summaryFailureReason}) and the request exceeds usable context capacity.`
      : "The in-flight turn and request frame exceed usable context capacity.",
  ).error;
}
