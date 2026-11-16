import type { CanonicalRecord } from "./canonical-transcript.js";
import type { FrozenState } from "./frozen-summary.js";
import type { ConversationMessage, ToolDefinition } from "./llm/types.js";
import { estimateTokens } from "./token-estimate.js";

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
function estimateJson(value: unknown): number {
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

/** Provider-independent estimate of native content, not an exact wire tokenizer. */
export function estimateMessageTokens(message: ConversationMessage): number {
  if (message.role === "assistant") {
    const { thinkingSignature: _signature, toolCalls, ...unsigned } = message;
    // Per-call opaque signatures are provider metadata, not prompt content; count
    // them out so signed calls do not inflate the estimate.
    const calls = toolCalls?.map(({ thoughtSignature: _callSignature, ...call }) => call);
    if (message.blocks !== undefined) {
      const { content: _content, thinking: _thinking, ...rest } = unsigned;
      const referenced = new Set(message.blocks.flatMap(block => block.type === "tool_use" ? [block.id] : []));
      // Ordered blocks replace convenience text/thinking. Tool-use blocks contain
      // only ids, so expand their arguments once rather than dropping them.
      const blocks = message.blocks.map(block => {
        if (block.type === "thinking") return { type: block.type, thinking: block.thinking };
        if (block.type === "tool_use") return { ...block, call: calls?.find(call => call.id === block.id) };
        return block;
      });
      return estimateJson({ ...rest, blocks, toolCalls: calls?.filter(call => !referenced.has(call.id)) });
    }
    return estimateJson({ ...unsigned, toolCalls: calls });
  }
  if (message.role !== "user" || typeof message.content === "string") return estimateJson(message);
  let imageTokens = 0;
  const content = message.content.map((part) => {
    if (part.type === "thinking") return { type: part.type, thinking: part.thinking };
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
  request: SummaryRequestMeta;
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

export function withDiscardedSummary<T extends object>(
  outcome: T,
  discardedSummary?: DiscardedSummary,
): T & { summaryDiscarded?: true; discardedSummary?: DiscardedSummary } {
  return discardedSummary ? { ...outcome, summaryDiscarded: true, discardedSummary } : outcome;
}

export function capacityError(
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
