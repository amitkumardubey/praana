import { estimateMessageTokens, requestFill, type CapacityErrorOutcome, type CompactionTurn, type RequestFill } from "./compaction.js";
import { buildRepairInstruction, buildSummaryInstruction, checkSummary, type SummaryFailure, type SummaryInstructionOptions } from "./frozen-summary.js";
import type { ConversationMessage, ProviderUsage, StreamRequest, ToolCall } from "./llm/types.js";
import { serializeToolResult } from "./llm/serialize.js";

/**
 * Preserve the last-sent prefix, including the entire terminal tool-result batch.
 * No tool choice, transport defaults, output-cap change or cache marker is added.
 */
export function buildSameModelSummaryRequest(
  live: StreamRequest,
  instruction: string | SummaryInstructionOptions,
): StreamRequest {
  return { ...live, messages: [
    ...live.messages,
    { role: "user", content: typeof instruction === "string" ? instruction : buildSummaryInstruction(instruction) },
  ] };
}

export interface SummaryResult {
  text: string;
  finishReason: "stop" | "length" | "tool_use" | "other";
  usage: ProviderUsage | null;
  toolCalls: readonly ToolCall[];
}

/** Tool calls invalidate the attempt even if the accompanying markdown is valid. */
export function summaryResponseHasToolCalls(result: Pick<SummaryResult, "toolCalls">): boolean {
  return result.toolCalls.length > 0;
}

export interface SummaryBatch {
  turnIds: number[];
  eventIds: string[];
  boundaryEventId: string;
  cutDescription: string;
  messages: ConversationMessage[];
  /** Includes a conservative allowance for an as-yet-unknown previous summary. */
  budgetedInputTokens: number;
}

export interface BatchSummaryOptions extends Omit<SummaryInstructionOptions, "cutDescription"> {
  contextWindowTokens: number;
  /** Effective cap of this separate request, including driver-specific output overhead. */
  effectiveMaxTokens: number;
}

export interface BatchSummaryPlan {
  template: StreamRequest;
  options: BatchSummaryOptions;
  batches: SummaryBatch[];
  /** One primary and at most one repair per batch. No model calls happen here. */
  maxCalls: number;
}

export type BatchSummaryPlanResult =
  | { status: "planned"; plan: BatchSummaryPlan }
  | { status: "not_foldable"; reason: "oversized_turn"; turnId: number; message: string }
  | CapacityErrorOutcome;

/** Plain data transcript: no native tool blocks requiring live tool definitions. */
function renderBatchMessage(message: ConversationMessage): ConversationMessage {
  if (message.role === "tool_result") {
    return { role: "user", content: `tool_result ${message.toolName}: ${serializeToolResult(message.result)}` };
  }
  const text = typeof message.content === "string" ? message.content :
    message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const lines = [`${message.role}: ${text}`];
  if (message.role === "assistant") {
    for (const call of message.toolCalls ?? []) lines.push(`tool_call ${call.name}(${JSON.stringify(call.args)})`);
  }
  return { role: "user", content: lines.join("\n") };
}

function batchTemplate(live: StreamRequest): StreamRequest {
  const template: StreamRequest = { model: live.model, provider: live.provider, messages: [] };
  if (live.reasoningEffort !== undefined) template.reasoningEffort = live.reasoningEffort;
  if (live.temperature !== undefined) template.temperature = live.temperature;
  if (live.baseUrl !== undefined) template.baseUrl = live.baseUrl;
  if (live.baseUrlOverride !== undefined) template.baseUrlOverride = live.baseUrlOverride;
  if (live.headers !== undefined) template.headers = { ...live.headers };
  if (live.compat !== undefined) template.compat = { ...live.compat };
  if (live.region !== undefined) template.region = live.region;
  if (live.api !== undefined) template.api = live.api;
  if (live.query !== undefined) template.query = { ...live.query };
  if (live.endpointUrl !== undefined) template.endpointUrl = live.endpointUrl;
  if (live.strictStreamEnd !== undefined) template.strictStreamEnd = live.strictStreamEnd;
  if (live.streamEndCheck !== undefined) template.streamEndCheck = live.streamEndCheck;
  if (live.connectTimeoutMs !== undefined) template.connectTimeoutMs = live.connectTimeoutMs;
  if (live.idleTimeoutMs !== undefined) template.idleTimeoutMs = live.idleTimeoutMs;
  return template;
}

/**
 * A separate compact request, not a continuation of the cached live prefix.
 * Transport/model settings survive; the live system, tools and history do not.
 * No driver cache controls are changed, and cache hits are not promised.
 */
export function buildBatchSummaryRequest(
  live: StreamRequest,
  batch: Pick<SummaryBatch, "messages">,
  options: SummaryInstructionOptions & { effectiveMaxTokens: number },
): StreamRequest {
  const { systemPrompt: _system, tools: _tools, messages: _messages, ...transport } = live;
  return buildSameModelSummaryRequest({ ...transport, maxTokens: options.effectiveMaxTokens, messages: batch.messages.map(renderBatchMessage) }, options);
}

function validateSummaryCap(capTokens: number): void {
  if (!Number.isSafeInteger(capTokens) || capTokens < 0 || !Number.isSafeInteger(6 * capTokens + 1)) {
    throw new RangeError("capTokens must be a non-negative safe integer with a safe serialized allowance.");
  }
}

function cutDescription(turn: CompactionTurn): string {
  return `through canonical event ${turn.eventIds.at(-1)!} (end of turn ${turn.turnId})`;
}

function summaryBatch(turns: readonly CompactionTurn[]): SummaryBatch {
  const last = turns.at(-1)!;
  const boundaryEventId = last.eventIds.at(-1)!;
  return {
    turnIds: turns.map(turn => turn.turnId), eventIds: turns.flatMap(turn => turn.eventIds), boundaryEventId,
    cutDescription: cutDescription(last),
    messages: turns.flatMap(turn => turn.messages), budgetedInputTokens: 0,
  };
}

/**
 * Greedy, whole-turn partition in supplied log order. Later batches budget for
 * any checked summary up to capTokens. JSON can expand one character to six
 * (e.g. a NUL to \\u0000), so reserve six times the raw-markdown cap, plus rounding.
 * Never use lexical event-id order or trust cached per-turn token estimates.
 * If even one turn cannot fit, return no partial plan: the caller must try
 * stubbing or a capacity outcome. A turn is never split to make it foldable.
 */
export function planBatchSummaries(
  live: StreamRequest,
  foldedTurns: readonly CompactionTurn[],
  options: BatchSummaryOptions,
): BatchSummaryPlanResult {
  validateSummaryCap(options.capTokens);
  const ids = foldedTurns.flatMap(turn => turn.eventIds);
  if (!foldedTurns.length || foldedTurns.some(turn => !turn.completed || !turn.eventIds.length) || new Set(ids).size !== ids.length) {
    throw new RangeError("Supply nonempty, completed folded turns with unique canonical event ids in log order.");
  }
  const template = batchTemplate(live);
  const batches: SummaryBatch[] = [];
  let pending: CompactionTurn[] = [];
  let pendingTokens = 0;
  let admittedTokens = 0;
  const flush = () => batches.push({ ...summaryBatch(pending), budgetedInputTokens: admittedTokens });
  for (const turn of foldedTurns) {
    // Each transcript message is rendered and estimated exactly once. Only the
    // instruction/frame is measured per candidate, since its cut text can vary.
    const turnTokens = turn.messages.reduce((sum, message) => sum + estimateMessageTokens(renderBatchMessage(message)), 0);
    const measureFrame = () => {
      const request = buildBatchSummaryRequest(template, { messages: [] }, {
        ...options, cutDescription: cutDescription(turn),
        previousSummary: batches.length ? "" : options.previousSummary,
      });
      return requestFill(request, request.messages, options.contextWindowTokens, options);
    };
    const allowance = () => batches.length ? 6 * options.capTokens + 1 : 0;
    let measured = measureFrame();
    if (!measured.ok) return measured.error;
    let budgetedTokens = pendingTokens + turnTokens + measured.fill.inputTokens + allowance();
    if (budgetedTokens > measured.fill.usableTokens && pending.length) {
      flush();
      pending = [];
      pendingTokens = 0;
      measured = measureFrame();
      if (!measured.ok) return measured.error;
      budgetedTokens = turnTokens + measured.fill.inputTokens + allowance();
    }
    if (budgetedTokens > measured.fill.usableTokens) {
      return { status: "not_foldable", reason: "oversized_turn", turnId: turn.turnId,
        message: `Turn ${turn.turnId} cannot fit a summary batch without splitting; try stubbing or report a capacity outcome.` };
    }
    pending.push(turn);
    pendingTokens += turnTokens;
    admittedTokens = budgetedTokens;
  }
  flush();
  return { status: "planned", plan: { template, options: { ...options }, batches, maxCalls: 2 * batches.length } };
}

export interface SummaryAttemptFailure {
  status: "failed";
  reason: "tool_calls" | "truncated" | "invalid_finish" | "invalid_summary" | "repair_exceeds_capacity" | "invalid_attempts";
  failures?: SummaryFailure[];
}

function checkResult(result: SummaryResult, capTokens: number): SummaryAttemptFailure | undefined {
  if (summaryResponseHasToolCalls(result) || result.finishReason === "tool_use") return { status: "failed", reason: "tool_calls" };
  if (result.finishReason === "length") return { status: "failed", reason: "truncated" };
  if (result.finishReason !== "stop") return { status: "failed", reason: "invalid_finish" };
  const check = checkSummary(result.text, { capTokens });
  return check.ok ? undefined : { status: "failed", reason: "invalid_summary", failures: check.failures };
}

export type SummaryRepairResult =
  | { status: "not_needed" }
  | { status: "repair"; request: StreamRequest; fill: RequestFill }
  | SummaryAttemptFailure
  | CapacityErrorOutcome;

/** Pure one-repair wiring. The caller owns calls/timeouts/cancellation and tracks attempt 0/1. */
export function buildSummaryRepairRequest(
  request: StreamRequest,
  result: SummaryResult,
  options: Pick<BatchSummaryOptions, "capTokens" | "contextWindowTokens" | "effectiveMaxTokens"> & { attempt: 0 | 1 },
): SummaryRepairResult {
  validateSummaryCap(options.capTokens);
  const failure = checkResult(result, options.capTokens);
  if (!failure) return { status: "not_needed" };
  if (failure.reason === "tool_calls" || failure.reason === "invalid_finish" || options.attempt !== 0) return failure;
  const empty = !result.text.trim();
  const repair = buildSameModelSummaryRequest({ ...request, messages: [
    ...request.messages, ...(empty ? [] : [{ role: "assistant" as const, content: result.text }]),
  ] }, buildRepairInstruction(failure.failures ?? []) +
    (failure.reason === "truncated" ? "\nThe previous output was cut off. Rewrite it to fit the output cap." : "") +
    (empty ? "\nThe previous attempt was empty." : ""));
  const measured = requestFill(repair, repair.messages, options.contextWindowTokens, options);
  if (!measured.ok) return measured.error;
  if (!measured.fill.fits) return { status: "failed", reason: "repair_exceeds_capacity" };
  return { status: "repair", request: repair, fill: measured.fill };
}

export interface BatchSummaryAttempt {
  result: SummaryResult;
  repair?: SummaryResult;
}

export type NextBatchSummaryResult =
  | { status: "request"; batchIndex: number; attempt: 0 | 1; request: StreamRequest; fill: RequestFill }
  | { status: "complete"; summary: string; boundaryEventId: string }
  | { status: "failed"; reason: "batch_exceeds_capacity"; batchIndex: number; inputTokens: number; usableTokens: number }
  | (SummaryAttemptFailure & { batchIndex: number })
  | CapacityErrorOutcome;

/**
 * Inspect ordered results without executing a loop or mutating a frozen state.
 * Each accepted block wholly replaces the previous one, never a field merge.
 * Only complete success publishes a summary/boundary; any later failure returns
 * neither, so the original state remains the caller's only committable state.
 */
export function nextBatchSummaryRequest(plan: BatchSummaryPlan, attempts: readonly BatchSummaryAttempt[]): NextBatchSummaryResult {
  if (attempts.length > plan.batches.length) return { status: "failed", reason: "invalid_attempts", batchIndex: plan.batches.length };
  let previousSummary = plan.options.previousSummary;
  for (let index = 0; index < plan.batches.length; index++) {
    const batch = plan.batches[index];
    const request = buildBatchSummaryRequest(plan.template, batch, { ...plan.options, cutDescription: batch.cutDescription, previousSummary });
    const measured = requestFill(request, request.messages, plan.options.contextWindowTokens, plan.options);
    if (!measured.ok) return measured.error;
    if (!measured.fill.fits) return { status: "failed", reason: "batch_exceeds_capacity", batchIndex: index,
      inputTokens: measured.fill.inputTokens, usableTokens: measured.fill.usableTokens };
    const attempt = attempts[index];
    if (!attempt) return { status: "request", batchIndex: index, attempt: 0, request, fill: measured.fill };
    const failure = checkResult(attempt.result, plan.options.capTokens);
    if (!failure) {
      if (attempt.repair) return { status: "failed", reason: "invalid_attempts", batchIndex: index };
      previousSummary = attempt.result.text;
    } else {
      if (failure.reason === "tool_calls" || failure.reason === "invalid_finish") return { ...failure, batchIndex: index };
      if (attempt.repair) {
        // A supplied repair is valid only if that repair request could be admitted.
        const repair = buildSummaryRepairRequest(request, attempt.result, { ...plan.options, attempt: 0 });
        if (repair.status === "capacity_error") return repair;
        if (repair.status === "failed") return { ...repair, batchIndex: index };
        const repairedFailure = checkResult(attempt.repair, plan.options.capTokens);
        if (repairedFailure) return { ...repairedFailure, batchIndex: index };
        previousSummary = attempt.repair.text;
      } else {
        if (index !== attempts.length - 1) return { status: "failed", reason: "invalid_attempts", batchIndex: index };
        const repair = buildSummaryRepairRequest(request, attempt.result, { ...plan.options, attempt: 0 });
        if (repair.status === "repair") return { ...repair, status: "request", batchIndex: index, attempt: 1 };
        if (repair.status === "capacity_error") return repair;
        return { ...(repair.status === "failed" ? repair : failure), batchIndex: index };
      }
    }
  }
  return { status: "complete", summary: previousSummary!, boundaryEventId: plan.batches.at(-1)!.boundaryEventId };
}
