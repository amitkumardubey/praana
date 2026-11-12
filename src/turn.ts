import {
  streamLlmResponse,
  type ConversationMessage,
  type ToolDefinition,
  type AssistantMessage,
  type StreamRequest,
} from "./llm/index.js";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "./llm/stream-guard.js";
import { appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { resolveDefaultSessionLogDir } from "./app-identity.js";
import { z, type ZodType } from "zod";
import type { Session } from "./session.js";
import type { StateObject, PraanaConfig } from "./types.js";
import type { AutoHydrateResult } from "./state-graph.js";
import type { CompileMetrics } from "./compiler.js";
import { buildAgentHints, buildFilesReadIndexSection } from "./compiler.js";
import { compileClassicWithMetrics } from "./compile-classic.js";
import {
  compileEngineWithMetrics,
  resolveContextEngineConfig,
  estimateTokens,
} from "./context-engine/index.js";
import { EmbeddingCache } from "./context-engine/embedding-cache.js";
import { buildArtifactCard } from "./context-engine/summarize.js";
import { buildSkillMetadataCatalog } from "./skills/index.js";
import { createAllTools, describeTools } from "./tools/index.js";
import { type ToolDefinition as RuntimeToolDefinition } from "./tools/tool-def.js";
import { createProvider, resolveModel, getReasoningEffort } from "./llm.js";
import { shouldUseOpenAIResponses } from "./llm/openai-routing.js";
import { OAuthRefreshBusyError, OAuthRefreshError, resolveOAuthModelAuth } from "./oauth.js";
import { CredentialLockTimeoutError } from "./credential-lock.js";
import {
  formatCompactionBanner,
  maybeAutoCompactClassic,
} from "./auto-compact.js";
import type { ContextEngine } from "./context-engine/index.js";
import { TurnRecorder } from "./context-engine/turn-recorder.js";
import { TurnAbortedError } from "./turn-control.js";
import { toolResultFromPreBlock } from "./hooks/block-result.js";
import type { TurnUiSink } from "./ui-events.js";
import { createDefaultTurnSink } from "./ui-events.js";
import {
  buildContextDisplaySnapshot,
  computeDistillerSavings,
  estimateAssistantMessageTokens,
  maxContextSnapshot,
} from "./context-display.js";
import { estimateTokens as estimateDisplayTokens } from "./token-estimate.js";
import { redactSecrets } from "./redact/secrets.js";
import { checkCircuitBudget } from "./circuit/budget.js";
import {
  createSessionLogger,
  extractLlmErrorMessage,
  formatUserFacingLlmError,
  type LogEntry,
} from "./logger.js";
import { printDebug, printMemoryBanner } from "./ui.js";
import { detectPlanApproval } from "./plan-mode.js";

type ProviderUsage = { input: number; output: number; totalTokens: number };

export type ProviderUsageUpdate = {
  step: ProviderUsage;
  cumulative: ProviderUsage;
  /** Latest API request input size — best proxy for context-window fill. */
  latestContextTokens: number;
};

export interface LlmStreamInput {
  model: any;
  modelName: string;
  providerName: string;
  compiledPrompt: string;
  history: any[];
  piTools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  signal?: AbortSignal;
  reasoningEffort?: string;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  streamEndCheck?: StreamRequest["streamEndCheck"];
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onProviderUsage?: (update: ProviderUsageUpdate) => void;
}

export interface LlmStreamResult {
  fullResponse: string;
  pendingToolCalls: Array<{
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
  }>;
  finalMessage: any | null;
  finalReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "timeout" | "rate_limit";
  errorMessage?: string;
  /** HTTP status from a provider error event, when the driver reported one. */
  status?: number;
  providerUsage: ProviderUsage | null;
  recordedProviderUsage: boolean;
  assistantTokens: number;
  interrupted: boolean;
  /** Answer text was already sent to the UI. A retry would duplicate it. */
  emittedToUi: boolean;
  /** A tool-call event was emitted. A premature-end retry would repeat it. */
  emittedToolCall: boolean;
  /** Driver said this failure can be retried. Read for a premature stream end. */
  retryable: boolean;
  /** `premature_end` or `connect_timeout` when the driver reported that kind. */
  errorKind?: "premature_end" | "connect_timeout";
  /** True only after a `done` event. A clean close without one stays false. */
  doneReceived: boolean;
}

export function isRecoverableStreamError(result: LlmStreamResult): boolean {
  if (result.interrupted) return false;
  if (result.status === 429 || result.status === 529) return true;
  const reason = result.finalReason;
  const msg = (result.errorMessage ?? "").toLowerCase();
  return (
    reason === "timeout" ||
    reason === "rate_limit" ||
    /\b(timeout|rate[ _-]?(?:limit|limited)|too\s+many\s+requests|overload(?:ed)?)\b|\b(?:status|http)\s*[:=]?\s*(?:429|529)\b/i.test(msg)
  );
}

export function isEmptyStreamResponse(result: LlmStreamResult): boolean {
  return (
    !result.interrupted &&
    result.finalReason === "stop" &&
    !result.fullResponse.trim() &&
    result.pendingToolCalls.length === 0
  );
}

export function shouldFallback(result: LlmStreamResult): boolean {
  return isRecoverableStreamError(result) || isEmptyStreamResponse(result);
}

/** Step-0 retry for a clean close that never delivered text or a tool call. */
export function isPrematureEndRetry(result: LlmStreamResult): boolean {
  if (result.interrupted || result.emittedToUi || result.emittedToolCall) return false;
  if (result.retryable !== true) return false;
  return result.errorKind === "premature_end";
}

/**
 * A fallback produced a usable answer and a real `done` event.
 * Empty stops, aborts, a close with no `done`, and a length stop with no text do not.
 * A length stop that includes text does, and that answer is committed.
 */
export function fallbackFinishedCleanly(result: LlmStreamResult): boolean {
  if (result.interrupted || !result.doneReceived || result.errorKind !== undefined) return false;
  if (result.finalReason === "length") return result.fullResponse.trim().length > 0;
  if (result.finalReason !== "stop" && result.finalReason !== "toolUse") return false;
  return !isEmptyStreamResponse(result);
}

/** Reason recorded when a fallback is committed. Idle timeout is not "empty response". */
export function recordedFallbackReason(result: LlmStreamResult, idleTimeoutMs: number): string {
  if (result.finalReason === "timeout") return `idle timeout after ${idleTimeoutDuration(idleTimeoutMs)}`;
  if (result.errorMessage) return result.errorMessage;
  if (result.errorKind === "premature_end") return "stream ended before the provider sent a final event";
  if (result.errorKind === "connect_timeout") return "connection timed out";
  return "empty response";
}

/**
 * User-facing line when the idle timer ends a stream.
 * The partial-answer sentence is included only when text was actually streamed.
 */
function idleTimeoutDuration(idleTimeoutMs: number): string {
  return idleTimeoutMs < 1000
    ? `${Math.max(0, idleTimeoutMs)}ms`
    : `${Math.round(idleTimeoutMs / 1000)}s`;
}

export function idleTimeoutUserMessage(idleTimeoutMs: number, streamedText = false): string {
  const base = `The model stopped responding (idle timeout after ${idleTimeoutDuration(idleTimeoutMs)}).`;
  return streamedText ? `${base} The partial answer above was not completed.` : base;
}

/**
 * Text kept from a timed-out assistant message.
 * Tool calls are dropped: a timeout does not run tools, so keeping them would
 * send a tool call with no tool result on the next request.
 * Returns null when no text remains.
 */
export function assistantTextAfterTimeout(message: unknown): AssistantMessage | null {
  if (!message || typeof message !== "object") return null;
  const record = message as {
    content?: unknown;
    thinking?: unknown;
    thinkingSignature?: unknown;
  };
  let text = "";
  if (typeof record.content === "string") {
    text = record.content;
  } else if (Array.isArray(record.content)) {
    text = record.content
      .filter(
        (part): part is { type?: string; text?: string } =>
          !!part && typeof part === "object" && (part as { type?: string }).type === "text",
      )
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  if (!text.trim()) return null;
  const kept: AssistantMessage = { role: "assistant", content: text };
  if (typeof record.thinking === "string" && record.thinking) kept.thinking = record.thinking;
  if (typeof record.thinkingSignature === "string" && record.thinkingSignature) {
    kept.thinkingSignature = record.thinkingSignature;
  }
  return kept;
}

function isConnectExhausted(result: LlmStreamResult): boolean {
  return result.errorKind === "connect_timeout";
}

/** Idle silence (`finalReason === "timeout"`). Not retried on the same model. */
function isIdleTimeout(result: LlmStreamResult): boolean {
  return result.finalReason === "timeout";
}

function configuredIdleTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

export async function runLlmStream(input: LlmStreamInput): Promise<LlmStreamResult> {
  const canonicalMessages: ConversationMessage[] = (input.history || []).map((m: any) => {
    if (m.role === "toolResult" || m.role === "tool_result") {
      const text = Array.isArray(m.content)
        ? m.content.map((c: any) => c.text || "").join("")
        : typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content);
      return {
        role: "tool_result" as const,
        toolCallId: m.toolCallId || "",
        toolName: m.toolName || "",
        result: text,
        isError: m.isError,
      };
    }
    if (m.role === "user") {
      return {
        role: "user" as const,
        content: typeof m.content === "string" ? m.content : m.content || "",
      };
    }
    if (m.role === "assistant") {
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
            : "";
      const toolCalls =
        m.toolCalls ||
        (Array.isArray(m.content)
          ? m.content
              .filter((c: any) => c.type === "tool_use" || c.type === "toolUse")
              .map((c: any) => ({
                id: c.id,
                name: c.name,
                args: c.input || c.args || {},
              }))
          : undefined);
      return {
        role: "assistant" as const,
        content: text,
        thinking: m.thinking,
        thinkingSignature: m.thinkingSignature,
        toolCalls,
      };
    }
    return {
      role: "system" as const,
      content: typeof m.content === "string" ? m.content : "",
    };
  });

  const tools: ToolDefinition[] = (input.piTools || []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const runtime = (input.model ?? {}) as {
    baseUrl?: string;
    baseUrlOverride?: boolean;
    api?: string;
    compat?: StreamRequest["compat"];
    maxTokens?: number;
    __piOptions?: {
      apiKey?: string;
      bearerToken?: string;
      headers?: Record<string, string>;
      region?: string;
      baseUrl?: string;
    };
  };
  const piOpts = runtime.__piOptions ?? {};

  const stream = streamLlmResponse({
    model: input.modelName,
    provider: input.providerName,
    systemPrompt: input.compiledPrompt,
    messages: canonicalMessages,
    tools,
    signal: input.signal,
    reasoningEffort: input.reasoningEffort as StreamRequest["reasoningEffort"],
    baseUrl: runtime.baseUrl ?? piOpts.baseUrl,
    baseUrlOverride: runtime.baseUrlOverride,
    headers: piOpts.headers,
    compat: runtime.compat,
    region: typeof piOpts.region === "string" ? piOpts.region : undefined,
    api: runtime.api,
    apiKey: piOpts.apiKey,
    bearerToken: piOpts.bearerToken,
    maxTokens: typeof runtime.maxTokens === "number" ? runtime.maxTokens : undefined,
    connectTimeoutMs: input.connectTimeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
    streamEndCheck: input.streamEndCheck,
  });

  let fullResponse = "";
  let assistantTokens = 0;
  let recordedProviderUsage = false;
  let providerUsage: ProviderUsage | null = null;
  let interrupted = false;
  const pendingToolCalls: LlmStreamResult["pendingToolCalls"] = [];
  let finalReason: LlmStreamResult["finalReason"] = "stop";
  let finalMessage: any = null;
  let errorMessage: string | undefined;
  let errorStatus: number | undefined;
  let emittedToUi = false;
  let emittedToolCall = false;
  let retryable = false;
  let errorKind: LlmStreamResult["errorKind"];
  let doneReceived = false;

  for await (const event of stream) {
    if (input.signal?.aborted) {
      interrupted = true;
      break;
    }
    if (event.type === "text_delta") {
      emittedToUi = true;
      input.onTextDelta?.(event.delta);
      fullResponse += event.delta;
    }
    if (event.type === "thinking_delta") {
      input.onThinkingDelta?.(event.delta);
    }
    if (
      event.type === "tool_call_start" ||
      event.type === "tool_call_delta" ||
      event.type === "tool_call_end" ||
      (event as { type?: string }).type === "toolcall_end"
    ) {
      emittedToolCall = true;
    }
    if (event.type === "tool_call_end" || (event as any).type === "toolcall_end") {
      const tc = (event as any).toolCall;
      pendingToolCalls.push({
        toolName: tc.name,
        args: tc.args ?? tc.arguments ?? {},
        toolCallId: tc.id,
      });
    }
    if (event.type === "usage") {
      recordedProviderUsage = true;
      providerUsage = event.usage;
      input.onProviderUsage?.({
        step: event.usage,
        cumulative: event.usage,
        latestContextTokens: event.usage.input,
      });
    }
    if (event.type === "done") {
      doneReceived = true;
      finalReason = event.reason === "tool_use" ? "toolUse" : (event.reason as any);
      finalMessage = event.message;
      const stepUsage = (event.message as any)?.usage ?? (event as any).usage;
      if (
        stepUsage &&
        Number.isFinite(stepUsage.input) &&
        Number.isFinite(stepUsage.output) &&
        (stepUsage.input > 0 || stepUsage.output > 0 || (stepUsage.totalTokens ?? 0) > 0)
      ) {
        recordedProviderUsage = true;
        providerUsage = stepUsage;
        input.onProviderUsage?.({
          step: stepUsage,
          cumulative: stepUsage,
          latestContextTokens: stepUsage.input,
        });
      }
    }
    if (event.type === "error") {
      finalReason = (event as any).reason ?? "error";
      if (typeof event.status === "number") errorStatus = event.status;
      retryable = event.retryable;
      if (event.kind === "premature_end" || event.kind === "connect_timeout") errorKind = event.kind;
      const err = (event as any).error;
      if (err) {
        if (typeof err === "string") {
          errorMessage = err;
        } else if (err.message) {
          errorMessage = err.message;
        } else if (err.errorMessage) {
          errorMessage = err.errorMessage;
        } else {
          errorMessage = extractLlmErrorMessage(err) ?? String(err);
        }
      }
    }
  }

  if (finalMessage) {
    assistantTokens = estimateAssistantMessageTokens(finalMessage);
  }

  return {
    fullResponse,
    pendingToolCalls,
    finalMessage,
    finalReason,
    errorMessage,
    status: errorStatus,
    providerUsage,
    recordedProviderUsage,
    assistantTokens,
    interrupted,
    emittedToUi,
    emittedToolCall,
    retryable,
    errorKind,
    doneReceived,
  };
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3);
}

function hasKeywordOverlap(a: string, b: string): boolean {
  const setA = new Set(extractKeywords(a));
  if (setA.size === 0) return false;
  for (const kw of extractKeywords(b)) {
    if (setA.has(kw)) return true;
  }
  return false;
}

function buildResumeNote(userInput: string, staleTasks: StateObject[]): string | undefined {
  if (staleTasks.length === 0) return undefined;
  const divergent = staleTasks.filter((t) => {
    const title = (t.payload as { title?: string }).title ?? "";
    return title.trim().length > 0 && !hasKeywordOverlap(title, userInput);
  });
  if (divergent.length === 0) return undefined;
  const titles = divergent
    .map((t) => (t.payload as { title?: string }).title ?? "untitled")
    .join("', '");
  const plural = divergent.length === 1 ? "" : "s";
  return `This session was resumed with stale active task${plural}: '${titles}'. The current message does not appear to reference this task. Confirm scope with the user before continuing, branching, or creating files. If the user is switching scope, call retract_task for the stale task before proceeding.`;
}
function countNoOpTools(toolName: string, result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const r = result as Record<string, unknown>;
  if (r.ok !== true) return 0;
  if (toolName === "edit_file" || toolName === "write_file") {
    return r.noOp === true ? 1 : 0;
  }
  if (toolName === "batch_edit" || toolName === "batch_write") {
    const count = r.noOpCount;
    return typeof count === "number" && Number.isFinite(count) ? Math.max(0, count) : 0;
  }
  return 0;
}

export interface ScorecardNudgeSnapshot {
  repeatFileReads: number;
  noOpTools: number;
  churnInterventions: number;
}

function snapshotScorecardNudge(
  session: Session,
  noOpTools = 0,
): ScorecardNudgeSnapshot {
  const c = session.scorecard?.getCounters?.();
  return {
    repeatFileReads: c?.repeatFileReads ?? 0,
    noOpTools,
    churnInterventions: c?.churnInterventions ?? 0,
  };
}

export function buildScorecardNudge(
  start: ScorecardNudgeSnapshot | null | undefined,
  end: ScorecardNudgeSnapshot | null | undefined,
  turnRecallCalls: number,
  turnRecallHits: number,
): string | undefined {
  if (!start || !end) return undefined;
  const churnDelta = end.churnInterventions - start.churnInterventions;
  if (churnDelta > 0) {
    return `Tip: read/retrieve churn detected; use one narrow retrieve_artifact or conclude.`;
  }
  const repeatReadsDelta = end.repeatFileReads - start.repeatFileReads;
  const noOpToolsDelta = end.noOpTools - start.noOpTools;
  const recallHitRate = turnRecallCalls > 0 ? turnRecallHits / turnRecallCalls : 1;

  if (repeatReadsDelta > 0) {
    return `Tip: you re-read files this turn; use search_session_log to recall prior reads.`;
  }
  if (noOpToolsDelta > 0) {
    return `Tip: a tool call made no changes; verify arguments before retrying.`;
  }
  if (turnRecallCalls > 0 && recallHitRate < 0.5) {
    return `Tip: memory recall had low hit rate; add a note or decide before recalling again.`;
  }
  return undefined;
}
/**
 * Characters of each tool result kept on a no-tools wrap-up request.
 * Longer text is cut and ends with `[truncated]` so the excerpt stays within
 * this cap (the marker counts toward the cap).
 */
export const WRAP_UP_TOOL_RESULT_CAP = 2000;

function textPartsOnly(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

function capWrapUpToolResult(text: string): string {
  if (text.length <= WRAP_UP_TOOL_RESULT_CAP) return text;
  const mark = "[truncated]";
  return text.slice(0, Math.max(0, WRAP_UP_TOOL_RESULT_CAP - mark.length)) + mark;
}

function isToolUsePart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const type = (part as { type?: unknown }).type;
  return type === "tool_use" || type === "toolUse" || type === "toolCall";
}

/** Keep the call's name and id, and cap its arguments the same way as results. */
function summarizeWrapUpToolCall(call: any): { id?: string; name?: string; args: string } {
  let id: string | undefined;
  if (typeof call?.id === "string") id = call.id;
  else if (typeof call?.toolCallId === "string") id = call.toolCallId;
  let name: string | undefined;
  if (typeof call?.name === "string") name = call.name;
  else if (typeof call?.toolName === "string") name = call.toolName;
  const args = call?.args ?? call?.arguments ?? call?.input;
  const raw = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return { id, name, args: capWrapUpToolResult(raw) };
}

function wrapUpToolResultText(message: { content?: unknown; result?: unknown }): string {
  if (Array.isArray(message.content)) return textPartsOnly(message.content);
  if (typeof message.result === "string") return message.result;
  if (typeof message.content === "string") return message.content;
  return textPartsOnly(message.result ?? message.content);
}

function appendMergedUser(out: Array<{ role: string; content: string }>, text: string): void {
  const prev = out[out.length - 1];
  if (prev?.role === "user") {
    prev.content = prev.content && text ? `${prev.content}\n\n${text}` : `${prev.content}${text}`;
    return;
  }
  out.push({ role: "user", content: text });
}

/**
 * History for a no-tools wrap-up call. Tool results become user text (text
 * parts only, capped), assistant tool calls become text, and adjacent user
 * messages are merged so providers that require alternating roles accept it.
 * Does not mutate `messages`.
 */
export function flattenWrapUpHistory(messages: readonly any[]): any[] {
  const out: any[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "toolResult" || message.role === "tool_result") {
      const text = wrapUpToolResultText(message);
      appendMergedUser(
        out,
        `Tool result (${message.toolName ?? "unknown"}, ${message.toolCallId ?? ""}): ${capWrapUpToolResult(text)}`,
      );
      continue;
    }
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content : textPartsOnly(message.content);
      appendMergedUser(out, text);
      continue;
    }
    if (message.role === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [];
      const calls = message.toolCalls ?? parts.filter((part: unknown) => isToolUsePart(part));
      if (!calls?.length) {
        out.push(message);
        continue;
      }
      const text = typeof message.content === "string" ? message.content : textPartsOnly(message.content);
      const summarized = (Array.isArray(calls) ? calls : []).map((call: any) => summarizeWrapUpToolCall(call));
      out.push({
        role: "assistant",
        content: `${text}${text ? "\n" : ""}Tool calls: ${JSON.stringify(summarized)}`,
      });
    }
  }
  return out;
}

/**
 * Positive integer, or `fallback`. Config loading already warns and substitutes
 * defaults; this clamp is silent so a NaN that bypasses validation cannot
 * make the step loop compare against NaN.
 */
function clampTurnInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Visible wrap-up text, or null when the reply is empty, whitespace, or thinking-only. */
function visibleWrapUpText(message: any): string | null {
  if (!message || typeof message !== "object") return null;
  const content = message.content;
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const text = textPartsOnly(content);
  return text.trim() ? text : null;
}

export async function runTurn(
  session: Session,
  userInput: string,
  modelOverride?: string,
  options?: {
    signal?: AbortSignal;
    sink?: TurnUiSink;
    /** Override the retry delay for deterministic callers and tests. */
    credentialRetryWait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  }
): Promise<string> {
  /* Always have a sink — default routes to legacy stdout/stderr helpers. */
  const s = options?.sink ?? createDefaultTurnSink();
  const successfulToolResult = (result: unknown, isError: boolean): boolean => {
    if (isError) return false;
    if (result && typeof result === "object" && "ok" in result) {
      return (result as { ok?: unknown }).ok !== false;
    }
    return true;
  };

  const turnRecorder = new TurnRecorder(userInput);
  const stateBeforeTurn = session.contextEngine?.captureStateSnapshot(
    session.stateGraph,
  );

  // 1. Append user_message
  session.eventLog.append({
    kind: "user_message",
    actor: "user",
    payload: { text: userInput },
  });
  session.setLastUserInput(userInput);

  // Leaving plan mode requires an explicit approval word or /plan execute.
  if (session.isPlanMode() && detectPlanApproval(userInput)) {
    session.exitPlanMode();
  }

  // 1b. Auto-hydrate peripheral objects matching user query keywords (engine mode only)
  const contextEngineEnabled =
    session.isContextEngineEnabled?.() ?? session.config.context_engine?.enabled ?? false;
  const useEngineCompiler = contextEngineEnabled && !!session.contextEngine;
  const classicMode = !useEngineCompiler;

  if (contextEngineEnabled && !session.contextEngine && session.debug) {
    s.onDebug?.("context engine unavailable — falling back to classic compiler");
  }

  let autoHydrated: AutoHydrateResult[] = [];
  if (!classicMode) {
    autoHydrated = session.stateGraph.autoHydrate(userInput);
    if (autoHydrated.length > 0) {
      for (const { id, method } of autoHydrated) {
        const obj = session.stateGraph.get(id)!;
        session.eventLog.append({
          kind: "context_action",
          actor: "kernel",
          payload: {
            action: "setTier",
            id,
            tier: "active",
            lastTouched: obj.lastTouched,
            reason: "auto_hydrate",
            hydrate_method: method,
          },
        });
      }
      if (session.debug) {
        s.onDebug?.(`auto-hydrated ${autoHydrated.length} object(s): ${autoHydrated.map((r) => r.id).join(", ")}`);
      }
    }
  }

  // 2. Build tools — boundaryTurn is captured once; /clear cannot run mid-turn
  // (TUI disables input + executeSlashCommand guards), so the value is stable.
  const boundaryTurn = session.getLastResetBoundaryTurn();
  const tools = createAllTools({
    eventLog: session.eventLog,
    stateGraph: session.stateGraph,
    memoryStore: session.memoryStore,
    memoryEnabled: session.memoryEnabled,
    incognito: session.isIncognito(),
    contextEngine: session.contextEngine,
    scorecard: session.scorecard,
    onScorecardFileRead: (absPath, mtimeMs, countAsRepeat) =>
      session.trackScorecardFileRead(absPath, mtimeMs, countAsRepeat),
    onScorecardSkillLoad: (skillId, bodyTokens) => session.scorecard.trackSkillLoad(skillId, bodyTokens),
    classicMode,
    cwd: session.cwd,
    sandbox: session.config.shell,
    scanTimeoutMs: session.config.search_code?.scan_timeout_ms,
    editConfirm: session.config.edit?.confirm,
    confirmAction: (request) => session.confirmAction(request),
    getCurrentTurn: () => session.getTurnCount(),
    getLastResetBoundaryTurn: () => boundaryTurn,
    getAbortSignal: () => options?.signal,
    shellLiveStream: s.shellLiveStream ?? true,
    skills: session.skills ?? [],
    skillRuntime: session.skillRuntime,
    blockRepeatReads: session.config.tools?.block_repeat_reads ?? false,
    webConfig: session.config.tools?.web,
    headless: session.headless,
    riskAllow: session.config.risk?.allow,
    webHostRemembered: (host) => session.webFetchHostRemembered(host),
    hasReadPath: (absPath) => session.scorecard.hasReadPath(absPath),
    getReadPathMtime: (absPath) => session.scorecard.getReadPathMtime(absPath),
    clearReadPath: (absPath) => {
      session.scorecard.clearReadPath(absPath);
      session.contextEngine?.clearFileReadAllRanges(absPath);
    },
    lspManager: session.lspManager,
    findFileReadArtifact: (absPath) => {
      const art = session.contextEngine?.findFileReadArtifact(absPath) ?? null;
      if (!art) return null;
      return {
        id: art.id,
        createdTurn: art.createdTurn,
        card: buildArtifactCard(
          art.id,
          art.sourceTool,
          art.command,
          art.rawTokens,
        ),
      };
    },
    findFileReadArtifactByRange: (absPath, offset, limit) => {
      const art = session.contextEngine?.findFileReadArtifactByRange(absPath, offset, limit) ?? null;
      if (!art) return null;
      return {
        id: art.id,
        createdTurn: art.createdTurn,
        card: buildArtifactCard(
          art.id,
          art.sourceTool,
          art.command,
          art.rawTokens,
        ),
      };
    },
  });

  const modelName = modelOverride ?? session.config.llm.model;
  let contextWindowTokens = await session.ensureModelContextWindow(modelName);

  const recentEvents = session.eventLog.readLastUncompressedAfterResetBoundary(
    session.config.compiler.recent_turns
  );
  const toolDescs = describeTools({ contextEngineEnabled, classicMode });

  const skillsSection = buildSkillMetadataCatalog(session.skills, session.skillUsefulness ?? undefined) || null;
  const tokenBudget = session.config.compiler.token_budget;
  const agentsBudgetRatio = session.config.compiler.agents_budget_ratio;

  const engineConfig = resolveContextEngineConfig(session.config);
  const checkpoint =
    contextEngineEnabled && session.contextEngine
      ? session.getVisibleSessionCheckpoint() ?? undefined
      : undefined;

  const staleTasks = session.isResumed?.() ? session.getStaleTasks?.() : [];
  const resumeNote = buildResumeNote(userInput, staleTasks ?? []);

  const compileInput = {
    stateGraph: session.stateGraph,
    memoryDigest: session.digest,
    recentEvents,
    userInput,
    toolSchemas: toolDescs,
    cwd: session.cwd,
    sessionId: session.id,
    tokenBudget,
    recentTurnsTokenBudget: session.config.compiler.recent_turns_token_budget,
    agentsContext: session.agentsContext,
    skillsPromptSection: skillsSection,
    checkpoint,
    memoriesBudgetRatio: session.config.compiler.memories_budget_ratio,
    agentsBudgetRatio,
    skillsSectionBudgetRatio: session.config.skills.max_token_budget_ratio,
    reservedOutputTokens: session.config.compiler.reserved_output_tokens,
    resumeNote,
    nativeStatus: session.nativeStatus,
  };

  await session.hooks.runPreCompile({
    session,
    // SAFETY: compileInput is a flat, JSON-serializable record of prompt
    // inputs for hooks; the cast widens the literal type to the hook ABI.
    input: compileInput as unknown as Record<string, unknown>,
  });

  let compiledPrompt: string;
  let promptMetrics: CompileMetrics;

  if (useEngineCompiler) {
    if (!session.embeddingCache) {
      session.embeddingCache = new EmbeddingCache();
    }
    // Pre-fetch all stored workflow patterns for injection into the compiled prompt
    // (issue #482). The compiler filters them to the classified task type internally.
    const workflowPatterns = session.contextEngine!.listAllWorkflowPatterns();
    const fileReads = session.contextEngine!.store.listFileReads();
    const filesReadIndex = fileReads.length > 0
      ? buildFilesReadIndexSection(fileReads, session.cwd)
      : "";
    const engineResult = await compileEngineWithMetrics({
      ...compileInput,
      currentTurn: session.getTurnCount(),
      turnRecords: session.contextEngine!.ledger
        .list()
        .filter(
          (r) => boundaryTurn < 0 || r.turn > boundaryTurn,
        ),
      activityEntries: session.contextEngine!.getRecentActivity().filter(
        (entry) => boundaryTurn < 0 || entry.turn > boundaryTurn,
      ),
      engineConfig,
      contextWindowTokens,
      hydratedTexts: autoHydrated.map((r) => r.text),
      embedder: session.memoryStore?.embedder ?? null,
      embeddingCache: session.embeddingCache,
      workflowPatterns,
      agentHints: buildAgentHints({
        repeatFileReads: session.scorecard.getCounters().repeatFileReads,
        churnInterventions: session.scorecard.getCounters().churnInterventions,
      }),
      circuitNotes: session.circuitNotes?.() ?? [],
      filesReadIndex,
      artifactTokens: (id) =>
        session.contextEngine?.store.getArtifact(id)?.rawTokens,
    });
    compiledPrompt = engineResult.prompt;
    promptMetrics = {
      ...engineResult.metrics,
      taskType: engineResult.taskType,
    };
    // Track task type for workflow pattern persistence at session end (issue #482).
    session.setLastKnownTaskType(engineResult.taskType);
    session.setLastCompileScoreRecords(
      engineResult.scoreRecords,
      engineResult.pressureMode,
      engineResult.pressureRatio,
      engineResult.weightedTokens,
      engineResult.rawPressureRatio,
    );
    session.contextEngine!.recordCompileTelemetry({
      turn: session.getTurnCount(),
      pressureMode: engineResult.pressureMode,
      excludedScoredUnits: engineResult.excludedScoredUnits,
    });
    if (session.debug && engineResult.scoreRecords.length > 0) {
      const scoresPath = join(session.promptDir, "scores.jsonl");
      if (!existsSync(session.promptDir)) {
        mkdirSync(session.promptDir, { recursive: true });
      }
      appendFileSync(
        scoresPath,
        engineResult.scoreRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
    }
  } else {
    let classicResult = compileClassicWithMetrics({
      cwd: session.cwd,
      sessionId: session.id,
      toolSchemas: toolDescs,
      agentsContext: session.agentsContext,
      projectContext: session.projectContext,
      skillsCatalog: skillsSection,
      memoryDigest: session.digest,
      events: session.eventLog.readAllUncompressed(),
      userInput,
      resumeNote,
      circuitNotes: session.circuitNotes?.() ?? [],
      nativeStatus: session.nativeStatus,
    });
    compiledPrompt = classicResult.prompt;
    promptMetrics = classicResult.metrics;

    const compaction = await maybeAutoCompactClassic(
      session,
      promptMetrics.totalTokens,
      modelName,
    );
    const compactionBanner = formatCompactionBanner(compaction);
    if (compactionBanner) {
      s.onDebug?.(compactionBanner);
      if (!session.debug) printDebug(compactionBanner);
    }
    if (compaction.compacted) {
      classicResult = compileClassicWithMetrics({
        cwd: session.cwd,
        sessionId: session.id,
        toolSchemas: toolDescs,
        agentsContext: session.agentsContext,
        projectContext: session.projectContext,
        skillsCatalog: skillsSection,
        memoryDigest: session.digest,
        events: session.eventLog.readAllUncompressed(),
        userInput,
        resumeNote,
        circuitNotes: session.circuitNotes?.() ?? [],
        nativeStatus: session.nativeStatus,
      });
      compiledPrompt = classicResult.prompt;
      promptMetrics = classicResult.metrics;
    }

    session.setLastCompileScoreRecords([], "normal", 0);
  }

  session.setLastCompileMetrics(promptMetrics);

  let turnHistoryTokens = estimateDisplayTokens(userInput);
  let turnDistillerSavings = 0;
  const contextBaseline = buildContextDisplaySnapshot({
    session,
    contextWindowTokens,
    engineMode: useEngineCompiler,
    historyTokens: turnHistoryTokens,
  });
  s.onTurnContextBaseline?.(contextBaseline);

  if (session.debug) {
    const turnNum = session.getTurnCount() + 1;
    const promptDir = session.promptDir;
    if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });
    const promptFile = join(promptDir, `turn-${String(turnNum).padStart(3, "0")}.md`);
    writeFileSync(promptFile, compiledPrompt, "utf-8");
    s.onDebug?.(`prompt saved → ${promptFile}`);
  }

  // 4. Create LLM provider and model
  const effectiveLlm = session.getEffectiveLlmConfig();
  // Refresh OAuth access tokens / baseUrl before building the model (no-op when unused).
  let oauthModelAuth: Awaited<ReturnType<typeof resolveOAuthModelAuth>> = null;
  let credentialError: string | undefined;
  async function resolveAuthWithRetry(provider: string): Promise<Awaited<ReturnType<typeof resolveOAuthModelAuth>>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await resolveOAuthModelAuth(provider, options?.signal);
      } catch (err) {
        if (!(err instanceof OAuthRefreshBusyError) || attempt >= 2 || options?.signal?.aborted) throw err;
        const wait = options?.credentialRetryWait ?? (async (ms: number, signal?: AbortSignal) => {
          const { setTimeout: delay } = await import("node:timers/promises");
          await delay(ms, undefined, { signal });
        });
        await wait((attempt + 1) * 1_000, options?.signal);
        if (options?.signal?.aborted) throw options.signal.reason;
      }
    }
  }
  try {
    oauthModelAuth = await resolveAuthWithRetry(effectiveLlm.provider);
  } catch (err) {
    if (options?.signal?.aborted) {
      // Cancellation is handled by the normal interrupted-turn path.
    } else if (err instanceof OAuthRefreshError || err instanceof OAuthRefreshBusyError) {
      credentialError = err.message;
    } else if (err instanceof CredentialLockTimeoutError || (err instanceof Error && err.name === "CredentialStoreReadError")) {
      credentialError = err.message;
    } else if (!(err instanceof Error && (options?.signal?.aborted || err.name === "AbortError"))) {
      session.getLogger().child("credentials").warn("OAuth token refresh failed", {
        cause: err as Error,
        code: "UNKNOWN",
        details: { provider: effectiveLlm.provider },
      });
    }
  }
  const providerFn = createProvider(effectiveLlm, contextWindowTokens);
  const model = providerFn(resolveModel(modelName)) as Record<string, unknown> & {
    baseUrl?: string;
    __piOptions?: Record<string, unknown>;
  };
  function applyOAuthAuth(target: typeof model, auth: typeof oauthModelAuth): void {
    if (!auth) return;
    if (auth.baseUrl) target.baseUrl = auth.baseUrl;
    target.__piOptions = {
      ...(target.__piOptions ?? {}),
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers
        ? { headers: { ...((target.__piOptions?.headers as Record<string, string> | undefined) ?? {}), ...auth.headers } }
        : {}),
    };
  }
  applyOAuthAuth(model, oauthModelAuth);

  const logger = await createSessionLogger({
    sessionId: session.id,
    sessionLogDir: session.config.session?.log_dir ?? resolveDefaultSessionLogDir(),
    debug: session.debug,
    suppressStderr: (session as Session).shouldSuppressLoggerStderr?.() ?? false,
  });
  const llmLogger = logger.child("llm");
  const providerName = effectiveLlm.provider;

  // 5. Stream response
  let fullResponse = "";
  let stepIndex = 0;
  let lastStreamReason: LlmStreamResult["finalReason"] = "stop";
  // Set around a wrap-up stream so the first visible delta is preceded by a
  // blank line when this turn already streamed step text.
  let armWrapSeparator = false;
  let wrapSeparatorSent = false;
  let wrapSpinnerOn = false;
  const stopWrapSpinner = () => {
    if (!wrapSpinnerOn) return;
    wrapSpinnerOn = false;
    s.onSpinnerStop?.();
  };
  let lastLlmErrorMessage: string | undefined;
  let providerUsage: ProviderUsage | null = null;
  let recordedProviderUsage = false;
  const history: any[] = [
    {
      role: "user",
      content: userInput,
      timestamp: Date.now(),
    },
  ];
  const maxSteps = clampTurnInt(session.config.turn?.max_steps, 25);
  // Pause/ceiling only when the sink can ask. Headless runs, and any sink
  // without `onStepPause` (subagents, tests, non-interactive UIs), use
  // `max_steps` as a hard cap: the last batch executes, then one wrap-up.
  // User-facing warnings for bad values live in validateConfig. Here a bad
  // value is only clamped so the loop bound stays a positive integer.
  const isHeadless = !!session.headless;
  const pauseAfterSteps = clampTurnInt(session.config.turn?.pause_after_steps, 50);
  const configuredHardMaxSteps = clampTurnInt(session.config.turn?.hard_max_steps, 300);
  // Keep the configured ceiling. When it is not above the pause interval the
  // ceiling is reached first, so the turn stops there and never asks.
  const hardMaxSteps = configuredHardMaxSteps;
  const pauseEnabled = !isHeadless && !!s.onStepPause;
  const loopCap = pauseEnabled ? hardMaxSteps : maxSteps;
  let interrupted = false;
  let surfacedTimeout = false;
  // Tracks whether any step in the turn ran a non-load_skill tool, for markResidentSkillsUsed.
  let hadNonLoadSkillTool = false;
  const nudgeStart = snapshotScorecardNudge(session);
  let noOpToolsThisTurn = 0;
  // Tracks memory entries already reinforced this turn so a recalled entry is
  // boosted at most once even if it appears in multiple parallel batches.
  const reinforcedEntryIdsThisTurn = new Set<string>();

  // Active model/provider may switch to fallback config if the primary fails.
  // Fallback is applied only to the initial stream attempt (step 0). Subsequent
  // tool-loop steps use the active (possibly fallback) model.
  let activeModelName = modelName;
  let activeProviderName = providerName;
  let activeModel = model;

  const piTools = Object.entries(tools).map(([name, def]) => ({
    name,
    description: String((def as any).description ?? ""),
    parameters: normalizeToolParameters((def as any).parameters),
  }));

  async function attemptStream(
    toolsForCall: typeof piTools = piTools,
    historyForCall = history,
  ): Promise<LlmStreamResult> {
    const reasoningEffort = getReasoningEffort(
      activeModel as Record<string, unknown>,
      activeModelName,
      activeProviderName,
      session.getEffectiveReasoningEffort(),
      {
        firstPartyResponses: shouldUseOpenAIResponses({
          provider: activeProviderName,
          model: typeof activeModel.id === "string" ? activeModel.id : activeModelName,
          baseUrl: typeof activeModel.baseUrl === "string" ? activeModel.baseUrl : undefined,
          baseUrlOverride: activeModel.baseUrlOverride === true,
        }),
      },
    );
    session.recordReasoningEffortUsed?.(reasoningEffort);
    return runLlmStream({
      model: activeModel,
      modelName: activeModelName,
      providerName: activeProviderName,
      compiledPrompt,
      history: historyForCall,
      piTools: toolsForCall,
      signal: options?.signal,
      reasoningEffort,
      onTextDelta: (delta) => {
        if (wrapSpinnerOn && delta.trim()) stopWrapSpinner();
        if (armWrapSeparator && delta.trim()) {
          armWrapSeparator = false;
          if (fullResponse.length > 0) {
            wrapSeparatorSent = true;
            s.onTextDelta?.("\n\n");
          }
        }
        s.onTextDelta?.(delta);
      },
      onThinkingDelta: (delta) => {
        s.onThinkingDelta?.(delta);
      },
      onProviderUsage: (update) => {
        session.recordInputTokens(update.step.input);
        session.recordOutputTokens(update.step.output);
        s.onProviderUsage?.(update);
      },
      connectTimeoutMs: session.config.llm.connect_timeout_ms,
      idleTimeoutMs: session.config.llm.stream_idle_timeout_ms,
      streamEndCheck: session.config.llm.stream_end_check,
    });
  }

  function canFallback(): boolean {
    const fallbackProvider = session.config.llm.fallback_provider;
    const fallbackModel = session.config.llm.fallback_model;
    if (!fallbackProvider || !fallbackModel) return false;
    // An explicit /model choice takes precedence and is never overwritten
    // by automatic fallback. If the user already set a model/provider override,
    // skip the automatic fallback path entirely.
    if (session.getModelOverride() || session.getProviderOverride()) return false;
    return true;
  }

  async function prepareFallback(fallbackProvider: string, fallbackModel: string): Promise<void> {
    activeProviderName = fallbackProvider;
    activeModelName = fallbackModel;
    contextWindowTokens = await session.ensureModelContextWindow(fallbackModel);

    const fallbackLlm: PraanaConfig["llm"] = {
      ...session.config.llm,
      provider: fallbackProvider,
      model: fallbackModel,
    };
    activeModel = createProvider(fallbackLlm, contextWindowTokens)(
      resolveModel(fallbackModel),
    );
  }

  function commitFallback(fallbackProvider: string, fallbackModel: string, reason: string): void {
    llmLogger.warn("Switched to fallback LLM", {
      code: "LLM_FALLBACK",
      details: {
        fromProvider: providerName,
        fromModel: modelName,
        toProvider: fallbackProvider,
        toModel: fallbackModel,
        reason,
      },
    });

    session.setProviderOverride(fallbackProvider);
    session.setModelOverride(fallbackModel);

    session.eventLog.append({
      kind: "system_note",
      actor: "kernel",
      payload: {
        type: "provider_override",
        provider: fallbackProvider,
        reason: "llm_fallback",
      },
    });
    session.eventLog.append({
      kind: "system_note",
      actor: "kernel",
      payload: {
        type: "model_override",
        model: fallbackModel,
        reason: "llm_fallback",
      },
    });

    s.onSystemLines?.([
      `Switched to ${fallbackProvider}/${fallbackModel} after ${reason}`,
    ]);
  }

  let credentialFallbackResult: LlmStreamResult | undefined;
  if (credentialError && canFallback() && !options?.signal?.aborted) {
    const fallbackProvider = session.config.llm.fallback_provider!;
    const fallbackModel = session.config.llm.fallback_model!;
    const heldText: string[] = [];
    const heldThinking: string[] = [];
    const restoreText = s.onTextDelta;
    const restoreThinking = s.onThinkingDelta;
    let fallbackAuth: typeof oauthModelAuth;
    try {
      fallbackAuth = await resolveAuthWithRetry(fallbackProvider);
      await prepareFallback(fallbackProvider, fallbackModel);
      applyOAuthAuth(activeModel, fallbackAuth);
      s.onTextDelta = (delta) => { heldText.push(delta); };
      s.onThinkingDelta = (delta) => { heldThinking.push(delta); };
      const result = await attemptStream();
      if (fallbackFinishedCleanly(result)) {
        credentialError = undefined;
        credentialFallbackResult = result;
        for (const delta of heldText) restoreText?.(delta);
        for (const delta of heldThinking) restoreThinking?.(delta);
        commitFallback(fallbackProvider, fallbackModel, `${providerName} sign-in unavailable`);
      } else if (options?.signal?.aborted) {
        credentialError = undefined;
      } else {
        credentialError += " (fallback unavailable)";
      }
    } catch (err) {
      if (options?.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        credentialError = undefined;
      } else if (err instanceof OAuthRefreshError || err instanceof OAuthRefreshBusyError ||
        err instanceof CredentialLockTimeoutError || (err instanceof Error && err.name === "CredentialStoreReadError")) {
        credentialError += " (fallback unavailable)";
      } else {
        throw err;
      }
    } finally {
      s.onTextDelta = restoreText;
      s.onThinkingDelta = restoreThinking;
    }
  }

  const NOT_EXECUTED_TEXT =
    "Not executed: the step budget was reached and the turn was stopped.";

  /** Record pending tool calls as errors without running them. */
  function appendNotExecutedResults(
    calls: Array<{ toolCallId?: string; toolName: string }>,
  ): void {
    for (const tc of calls) {
      history.push({
        role: "toolResult",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        content: [{ type: "text", text: NOT_EXECUTED_TEXT }],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }

  /** Drop tool calls the wrap-up was told not to make, so they are not stored or run. */
  function withoutWrapUpToolCalls(message: any): any {
    if (!message || typeof message !== "object") return message;
    const hadCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
    let content = message.content;
    let strippedContent = false;
    if (Array.isArray(content)) {
      const next = content.filter((part: unknown) => !isToolUsePart(part));
      strippedContent = next.length !== content.length;
      content = next;
    }
    if (!hadCalls && !strippedContent) return message;
    const nextMessage = { ...message, content };
    delete nextMessage.toolCalls;
    return nextMessage;
  }

  function logWrapUpFailure(reason: string, error: string | undefined): void {
    const message = error ?? "LLM stream error";
    llmLogger.warn("Wrap-up summary stream failed; ending turn", {
      code: "LLM_STREAM_ERROR",
      details: {
        reason,
        error: message,
        model: activeModelName,
        provider: activeProviderName,
      },
    });
    lastStreamReason = "error";
    lastLlmErrorMessage = message;
    // When this turn already has text, this is the only report. A tool-only
    // turn has an empty fullResponse, and the end-of-turn empty-response path
    // reports the same error once (plus the banner). Calling both doubles it.
    if (fullResponse.trim()) {
      s.onError?.({
        level: "error",
        domain: "llm",
        message,
        code: "LLM_STREAM_ERROR",
        details: {
          model: activeModelName,
          provider: activeProviderName,
          reason: "error",
        },
      });
    }
  }

  /**
   * Stop the turn gracefully at a step budget limit: one no-tool model call
   * asking for a short summary. The instruction exists only for that call and
   * is removed afterwards (the reply, when it has visible text, is the record).
   * Tool calls in the reply are dropped and not executed. A stream error is
   * logged and reported through `onError`. Ctrl+C sets `interrupted` and
   * `lastStreamReason` to aborted, keeping any partial text that was stored.
   */
  async function wrapUpStep(reason: string): Promise<void> {
    const instruction = {
      role: "user",
      content: `${reason} Reply with a short summary of what was done and what remains. Do not call tools.`,
      timestamp: Date.now(),
    };
    history.push(instruction);
    const dropInstruction = () => {
      const idx = history.lastIndexOf(instruction);
      if (idx >= 0) history.splice(idx, 1);
    };
    wrapSeparatorSent = false;
    armWrapSeparator = true;
    wrapSpinnerOn = true;
    s.onSpinnerStart?.("wrapping up…");
    try {
      const wrap = await attemptStream([], flattenWrapUpHistory(history));
      stopWrapSpinner();
      const streamed = wrap.fullResponse;
      const fromMessage = visibleWrapUpText(withoutWrapUpToolCalls(wrap.finalMessage));
      const text = streamed.trim() ? streamed : fromMessage;
      // Show and count a summary only when it is stored. An errored wrap-up
      // keeps neither, and an aborted reply with no visible text is not stored.
      const publishSummary = () => {
        if (!text) return;
        if (!streamed.trim()) {
          if (fullResponse.length > 0) {
            wrapSeparatorSent = true;
            s.onTextDelta?.("\n\n");
          }
          s.onTextDelta?.(text);
        }
        if (wrapSeparatorSent) fullResponse += "\n\n";
        fullResponse += text;
        history.push({ role: "assistant", content: text, timestamp: Date.now() });
        if (wrap.finalMessage && wrap.assistantTokens > 0) {
          turnHistoryTokens += wrap.assistantTokens;
          s.onContextHistoryDelta?.({
            tokensAdded: wrap.assistantTokens,
            source: "assistant",
          });
        }
      };
      const aborted =
        wrap.interrupted ||
        !!options?.signal?.aborted ||
        wrap.finalReason === "aborted";
      if (aborted) {
        publishSummary();
        providerUsage = wrap.providerUsage ?? providerUsage;
        recordedProviderUsage = wrap.recordedProviderUsage || recordedProviderUsage;
        lastStreamReason = "aborted";
        interrupted = true;
        return;
      }
      if (wrap.finalReason === "error") {
        logWrapUpFailure(reason, wrap.errorMessage);
        return;
      }
      lastStreamReason = wrap.finalReason === "toolUse" ? "stop" : wrap.finalReason;
      lastLlmErrorMessage = undefined;
      providerUsage = wrap.providerUsage ?? providerUsage;
      recordedProviderUsage = wrap.recordedProviderUsage || recordedProviderUsage;
      publishSummary();
    } catch (err) {
      stopWrapSpinner();
      if (options?.signal?.aborted) {
        lastStreamReason = "aborted";
        interrupted = true;
        return;
      }
      logWrapUpFailure(reason, err instanceof Error ? err.message : String(err));
    } finally {
      stopWrapSpinner();
      armWrapSeparator = false;
      dropInstruction();
    }
  }

  for (let step = 0; step < loopCap && !credentialError; step++) {
    if (options?.signal?.aborted) {
      interrupted = true;
      break;
    }

    let streamResult = credentialFallbackResult ?? await attemptStream();
    credentialFallbackResult = undefined;
    let fallbackRejected = false;

    // On the first step, retry once and then fall back on recoverable failures.
    // Once answer text has reached the UI, another attempt would repeat it.
    // An idle timeout is not retried on the same model: another silent attempt
    // would wait the full idle budget again. Go to the fallback when one is
    // allowed, otherwise surface the error.
    if (
      step === 0 &&
      !streamResult.emittedToUi &&
      (shouldFallback(streamResult) || isPrematureEndRetry(streamResult))
    ) {
      // A connect timeout already had its one driver-level retry. An idle
      // timeout is not retried here either. Go to the fallback model.
      if (!isIdleTimeout(streamResult) && !isConnectExhausted(streamResult)) {
        streamResult = await attemptStream();
      }
      // The retry may have streamed text. Do not ask the fallback model after that.
      if (
        !streamResult.emittedToUi &&
        (shouldFallback(streamResult) || isPrematureEndRetry(streamResult)) &&
        canFallback()
      ) {
        const fallbackProvider = session.config.llm.fallback_provider!;
        const fallbackModel = session.config.llm.fallback_model!;
        const fallbackReason = recordedFallbackReason(
          streamResult,
          configuredIdleTimeoutMs(session.config.llm.stream_idle_timeout_ms),
        );

        // Hold fallback text until the switch is committed. A rejected
        // fallback must not reach the user, and the primary stays active.
        const heldText: string[] = [];
        const heldThinking: string[] = [];
        const restoreText = s.onTextDelta;
        const restoreThinking = s.onThinkingDelta;
        const primaryModel = activeModel;
        const primaryWindow = contextWindowTokens;
        s.onTextDelta = (delta) => { heldText.push(delta); };
        s.onThinkingDelta = (delta) => { heldThinking.push(delta); };
        let committed = false;
        try {
          await prepareFallback(fallbackProvider, fallbackModel);
          const fallbackResult = await attemptStream();
          if (fallbackFinishedCleanly(fallbackResult)) {
            for (const delta of heldText) restoreText?.(delta);
            for (const delta of heldThinking) restoreThinking?.(delta);
            commitFallback(fallbackProvider, fallbackModel, fallbackReason);
            streamResult = fallbackResult;
            committed = true;
          }
        } finally {
          s.onTextDelta = restoreText;
          s.onThinkingDelta = restoreThinking;
          if (!committed) {
            activeModel = primaryModel;
            activeModelName = modelName;
            activeProviderName = providerName;
            contextWindowTokens = primaryWindow;
            fallbackRejected = true;
          }
        }
      }
    }

    let streamedTimeoutText = false;
    if (streamResult.finalReason === "timeout" || isConnectExhausted(streamResult)) {
      const kept = assistantTextAfterTimeout(streamResult.finalMessage);
      streamedTimeoutText = streamResult.finalReason === "timeout" && kept !== null;
      streamResult = {
        ...streamResult,
        pendingToolCalls: [],
        finalMessage: kept,
        assistantTokens: kept ? estimateAssistantMessageTokens(kept) : 0,
      };
    }

    // A rejected fallback keeps the primary result. A recoverable primary
    // failure (rate limit, overload) is still reported as an error. An empty
    // stop stays an empty response, and an idle timeout keeps its own message.
    if (
      streamResult.finalReason !== "timeout" &&
      fallbackRejected &&
      isRecoverableStreamError(streamResult)
    ) {
      lastStreamReason = "error";
      lastLlmErrorMessage = streamResult.errorMessage ?? "LLM request failed";
      break;
    }

    // Log errors from the final stream attempt.
    if (
      streamResult.finalReason === "error" ||
      streamResult.finalReason === "aborted" ||
      streamResult.finalReason === "timeout"
    ) {
      const llmMessage =
        streamResult.finalReason === "timeout"
          ? idleTimeoutUserMessage(
              configuredIdleTimeoutMs(session.config.llm.stream_idle_timeout_ms),
              streamedTimeoutText,
            )
          : streamResult.errorMessage;
      lastStreamReason = streamResult.finalReason;
      lastLlmErrorMessage = llmMessage;
      if (streamResult.finalReason === "aborted") {
        llmLogger.warn("LLM stream aborted", {
          code: "LLM_ABORTED",
          details: { model: activeModelName, provider: activeProviderName, message: llmMessage },
        });
      } else {
        llmLogger.error("LLM stream error", {
          code: "LLM_STREAM_ERROR",
          details: { model: activeModelName, provider: activeProviderName, reason: streamResult.finalReason, message: llmMessage },
        });
        const errorEntry: LogEntry = {
          level: "error",
          domain: "llm",
          message: llmMessage ?? "LLM stream error",
          code: "LLM_STREAM_ERROR",
          details: { model: activeModelName, provider: activeProviderName, reason: streamResult.finalReason },
        };
        s.onError?.(errorEntry);
        if (streamResult.finalReason === "timeout") surfacedTimeout = true;
      }
    }

    lastStreamReason = streamResult.finalReason;
    if (streamResult.finalReason === "error" || streamResult.finalReason === "aborted") {
      lastLlmErrorMessage = streamResult.errorMessage ?? lastLlmErrorMessage;
    }

    fullResponse += streamResult.fullResponse;
    providerUsage = streamResult.providerUsage;
    recordedProviderUsage = streamResult.recordedProviderUsage;
    if (streamResult.interrupted || options?.signal?.aborted) {
      interrupted = true;
      break;
    }

    if (streamResult.finalMessage) {
      const assistantTokens = streamResult.assistantTokens;
      if (assistantTokens > 0) {
        turnHistoryTokens += assistantTokens;
        s.onContextHistoryDelta?.({
          tokensAdded: assistantTokens,
          source: "assistant",
        });
      }
      history.push(streamResult.finalMessage);
    }

    const pendingToolCalls = streamResult.pendingToolCalls;
    if (!pendingToolCalls.length || streamResult.finalReason !== "toolUse") {
      break;
    }

    if (session.headless) {
      const tokens = (providerUsage?.input ?? 0) + (providerUsage?.output ?? 0);
      const reason = checkCircuitBudget({
        maxTokens: session.config.circuit?.max_tokens ?? 0,
        maxWallMs: session.config.circuit?.max_wall_ms ?? 0,
        tokens,
        elapsedMs: Date.now() - session.getStartedAt(),
      });
      if (reason) {
        session.scorecard.inc("circuitBudgetWrapups");
        appendNotExecutedResults(pendingToolCalls);
        await wrapUpStep(`Circuit budget exceeded (${reason}).`);
        break;
      }
    }

    // Interactive soft pause and hard ceiling. Only when the sink provides
    // onStepPause. The pending batch is not executed: stopping must not edit
    // files. Each call is recorded as an error so the wrap-up request is valid.
    if (pauseEnabled && pendingToolCalls.length > 0) {
      const stepsUsed = step + 1;
      if (stepsUsed >= hardMaxSteps) {
        s.onSystemLines?.([`Reached the step limit (${stepsUsed}).`]);
        appendNotExecutedResults(pendingToolCalls);
        await wrapUpStep("Hard per-turn step ceiling reached.");
        break;
      }
      if (stepsUsed % pauseAfterSteps === 0) {
        const signal = options?.signal;
        const pauseController = new AbortController();
        const onAbort = () => pauseController.abort();
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        const aborted = new Promise<boolean>((resolve) => {
          if (pauseController.signal.aborted) resolve(false);
          else pauseController.signal.addEventListener("abort", () => resolve(false), { once: true });
        });
        let cont: boolean;
        try {
          cont = (await Promise.race([Promise.resolve(s.onStepPause!(stepsUsed, pauseController.signal)), aborted])) !== false;
        } catch (err) {
          llmLogger.warn("Step pause hook failed; stopping turn", {
            details: { stepsUsed, error: err instanceof Error ? err.message : String(err) },
          });
          cont = false;
        } finally {
          signal?.removeEventListener("abort", onAbort);
          pauseController.abort();
        }
        if (options?.signal?.aborted) {
          appendNotExecutedResults(pendingToolCalls);
          interrupted = true;
          break;
        }
        if (!cont) {
          s.onSystemLines?.(["Stopped at the step pause."]);
          appendNotExecutedResults(pendingToolCalls);
          await wrapUpStep("Stopped at per-turn step pause.");
          break;
        }
      }
    }

    const toolResults: Array<{ toolCallId?: string; toolName: string; result: unknown }> = [];
    const recalledEntryIdsThisTurn = new Set<string>();


    // Notify caller that tool calls are about to execute (e.g. close thinking block)
    s.onToolCallsStart?.();

    // Phase 1: notify UI and log all incoming tool calls so parallel batches are visible
    // as pending rows in the TUI before any execution begins.
    for (const tc of pendingToolCalls) {
      const loggedArgs = redactSecrets(tc.args ?? {}) as Record<string, unknown>;
      session.eventLog.append({
        kind: "tool_call",
        actor: "tool",
        payload: { toolCallId: tc.toolCallId, tool: tc.toolName, args: loggedArgs },
      });
      s.onToolCall?.(tc.toolCallId, tc.toolName, loggedArgs);
      if (tc.toolName !== "load_skill") hadNonLoadSkillTool = true;
    }

    // Phase 2: execute tool calls concurrently.
    if (options?.signal?.aborted) {
      interrupted = true;
    } else {
      const uniqueToolNames = [
        ...new Set(pendingToolCalls.map((tc) => tc.toolName)),
      ];
      const spinnerLabel =
        uniqueToolNames.length === 1
          ? uniqueToolNames[0]!
          : uniqueToolNames.length <= 3
            ? uniqueToolNames.join(", ")
            : `${uniqueToolNames.slice(0, 3).join(", ")}, … (${uniqueToolNames.length} tools)`;
      s.onSpinnerStart?.(spinnerLabel);

      const executedResults = await Promise.all(
        pendingToolCalls.map(async (tc) => {
          // Cooperative abort: if the session abort signal has already fired,
          // don't start new tool work in this batch.
          if (options?.signal?.aborted) {
            return {
              tc,
              result: { ok: false, error: "Interrupted" },
              isError: true,
            };
          }

          const toolDef = (tools as Record<string, RuntimeToolDefinition>)[tc.toolName];
          let result: unknown;
          let isError = false;

          if (!toolDef || typeof toolDef.execute !== "function") {
            isError = true;
            result = { ok: false, error: `Unknown tool: ${tc.toolName}` };
          } else {
            const pre = await session.hooks.runPreToolCall({
              toolName: tc.toolName,
              args: (tc.args ?? {}) as Record<string, unknown>,
              session,
            });
            if (pre.action === "block") {
              isError = pre.isError;
              result = toolResultFromPreBlock(pre);
            } else {
              try {
                result = await toolDef.execute(pre.args);
              } catch (err: any) {
                isError = true;
                result = { ok: false, error: err?.message ?? "Tool execution failed" };
              }
              const post = await session.hooks.runPostToolCall({
                toolName: tc.toolName,
                args: pre.args,
                result,
                isError,
                session,
              });
              result = post.result;
              isError = post.isError;
            }
          }

          return { tc, result, isError };
        }),
      );

      s.onSpinnerStart?.("thinking…");

      // Collect recalled entries from all recall calls in the batch.
      for (const { tc, result, isError } of executedResults) {
        if (tc.toolName === "recall" && successfulToolResult(result, isError)) {
          const entries = (result as { entries?: Array<{ id?: string }> }).entries;
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              if (typeof entry?.id === "string" && entry.id) {
                recalledEntryIdsThisTurn.add(entry.id);
              }
            }
          }
        }
      }

      // Process results in original order to keep history/event log deterministic.
      for (const { tc, result, isError } of executedResults) {
        toolResults.push({ toolCallId: tc.toolCallId, toolName: tc.toolName, result });
        if (!isError) noOpToolsThisTurn += countNoOpTools(tc.toolName, result);

        let promptResultText = toolResultRawText(result);
        let artifactId: string | undefined;
        const skippedDisk =
          result &&
          typeof result === "object" &&
          (result as { skipped_disk?: unknown }).skipped_disk === true;
        const resultArtifactId =
          result &&
          typeof result === "object" &&
          typeof (result as { artifact_id?: unknown }).artifact_id === "string"
            ? ((result as { artifact_id: string }).artifact_id)
            : undefined;
        const isRetrievalResult =
          tc.toolName === "retrieve_artifact" &&
          !isError &&
          result &&
          typeof result === "object" &&
          (result as { ok?: unknown }).ok === true &&
          typeof (result as { id?: unknown }).id === "string";
        const retrievalArtifactId = isRetrievalResult
          ? (result as { id: string }).id
          : undefined;

        if (session.contextEngine && (skippedDisk || isRetrievalResult)) {
          // Repeat-read interceptor and artifact retrievals: never re-ingest their
          // payloads as new source artifacts; just surface the referenced artifact.
          // Touch access only for the repeat-read path — retrieve_artifact already
          // touches internally via ArtifactStore.retrieve(), so an extra touch here
          // would double-increment access_count (skewing promotion and eviction).
          artifactId = resultArtifactId ?? retrievalArtifactId;
          if (artifactId && skippedDisk) {
            session.contextEngine.touchAccess(artifactId, session.getTurnCount());
          }
          promptResultText =
            typeof (result as { content?: unknown }).content === "string"
              ? (result as { content: string }).content
              : promptResultText;
          const toolTokens = estimateDisplayTokens(promptResultText);
          turnHistoryTokens += toolTokens;
          s.onContextHistoryDelta?.({
            tokensAdded: toolTokens,
            source: "tool",
          });
        } else if (session.contextEngine) {
          const command = resolveToolCommand(
            tc.toolName,
            tc.args as Record<string, unknown>,
            session.cwd,
          );
          // For read_file, store the raw content and original line range for
          // lossless retrieval. For other tools, promptResultText is the raw result.
          let ingestContent = promptResultText;
          let sourceLineStart: number | undefined;
          let sourceLineEnd: number | undefined;
          let requestStart: number | undefined;
          let requestEnd: number | undefined;
          let requestUnbounded: boolean | undefined;
          if (tc.toolName === "read_file") {
            const resultContent = typeof result === "object" && result !== null
              ? (result as { content?: unknown }).content
              : undefined;
            if (typeof resultContent === "string") {
              ingestContent = resultContent;
            }
            const args = tc.args as { offset?: number; limit?: number };
            const offset = args.offset;
            const limit = args.limit;
            sourceLineStart = offset ?? 1;
            const outputLines = ingestContent.split("\n").length;
            // sourceLineEnd reflects what was actually read, not the requested limit.
            sourceLineEnd = sourceLineStart + Math.max(0, outputLines - 1);
            // requestStart/requestEnd preserve the original request for cache key identity.
            // This ensures that a repeat of the same request (even at EOF) hits the cache.
            requestStart = sourceLineStart;
            requestEnd = limit !== undefined ? sourceLineStart + limit - 1 : 0;
            requestUnbounded = limit === undefined;
          }
          const ingested = session.contextEngine.ingestToolResult({
            sourceTool: tc.toolName,
            command,
            rawText: ingestContent,
            createdTurn: session.getTurnCount(),
            sourceLineStart,
            sourceLineEnd,
            requestStart,
            requestEnd,
            requestUnbounded,
          });
          promptResultText = ingested.promptText;
          artifactId = ingested.artifactId;
          const toolTokens = estimateDisplayTokens(promptResultText);
          const savings = computeDistillerSavings(
            toolResultRawText(result),
            promptResultText,
            ingested.inlined,
          );
          turnHistoryTokens += toolTokens;
          turnDistillerSavings += savings;
          s.onContextHistoryDelta?.({
            tokensAdded: toolTokens,
            source: "tool",
            distillerSavings: savings > 0 ? savings : undefined,
          });
        } else {
          const toolTokens = estimateDisplayTokens(promptResultText);
          turnHistoryTokens += toolTokens;
          s.onContextHistoryDelta?.({
            tokensAdded: toolTokens,
            source: "tool",
          });
        }

        turnRecorder.recordToolCall({
          tool: tc.toolName,
          args: redactSecrets(tc.args ?? {}) as Record<string, unknown>,
          result,
          isError,
          artifactId,
        });

        history.push({
          role: "toolResult",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          content: [{ type: "text", text: promptResultText }],
          isError,
          timestamp: Date.now(),
        });

        session.eventLog.append({
          kind: "tool_result",
          actor: "tool",
          payload: { toolCallId: tc.toolCallId, tool: tc.toolName, result },
        });

        // Notify UI sink of tool result for distinct rendering (e.g. TUI).
        // Shell uses raw result so TUI shows stdout/stderr even when context engine artifacts.
        const uiResultText =
          tc.toolName === "shell" ? toolResultRawText(result) : promptResultText;
        s.onToolResult?.(tc.toolCallId, tc.toolName, uiResultText, isError);
      }

      // Reinforce any recalled entries once per turn when at least one non-recall
      // tool succeeds. Skip entries already reinforced earlier in this turn so a
      // recalled entry is boosted at most once even if it appears in multiple batches.
      const newEntryIds = Array.from(recalledEntryIdsThisTurn).filter(
        (id) => !reinforcedEntryIdsThisTurn.has(id),
      );
      if (
        newEntryIds.length > 0 &&
        executedResults.some(
          ({ tc, result, isError }) =>
            tc.toolName !== "recall" && successfulToolResult(result, isError),
        )
      ) {
        session.memoryStore?.reinforceFromSuccessfulToolOutcome(newEntryIds);
        for (const id of newEntryIds) {
          reinforcedEntryIdsThisTurn.add(id);
        }
      }

      if (options?.signal?.aborted) {
        interrupted = true;
      }
    }

    if (interrupted) break;

    stepIndex++;
    if (session.debug) {
      s.onDebugBlock?.(stepIndex, pendingToolCalls, toolResults);
    }

    // Hard cap for headless runs and sinks that cannot pause: the last batch
    // has already executed. One no-tool wrap-up, then the turn ends.
    if (!pauseEnabled && step === maxSteps - 1) {
      s.onSystemLines?.([`Reached the step limit (${step + 1}).`]);
      await wrapUpStep("Reached per-turn tool step limit.");
      break;
    }
  }

  // Mark resident skills as used if any non-load_skill tool call executed this turn.
  // "loaded a skill and did nothing else" is the idle case the usefulness loop penalizes.
  if (session.skillRuntime && hadNonLoadSkillTool) {
    session.skillRuntime.markResidentSkillsUsed();
  }

  if (interrupted) {
    commitTurnContextDisplay(session, s, {
      contextWindowTokens,
      engineMode: useEngineCompiler,
      historyTokens: turnHistoryTokens,
      distillerSavingsTurn: turnDistillerSavings,
    });
    return await finalizeInterruptedTurn(
      session,
      fullResponse,
      autoHydrated.length,
      promptMetrics.totalTokens,
      turnRecorder,
      userInput,
      stateBeforeTurn,
      classicMode,
      s,
      providerUsage,
      recordedProviderUsage,
    );
  }

  if (fullResponse && !fullResponse.endsWith("\n")) {
    s.onNewline?.();
    fullResponse += "\n";
  }

  if (credentialError) {
    // Shown as an error line only. The model never ran, so this is not a turn:
    // do not charge tokens, record a ledger row, or advance the turn count.
    // Leave the user message out of the next prompt so it is not a dangling turn.
    s.onError?.({
      level: "error",
      domain: "credentials",
      message: credentialError,
      code: "UNKNOWN",
    });
    const events = session.eventLog.readAll();
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.kind === "user_message" && event.payload.text === userInput) {
        session.eventLog.markEventsAsCompressed([event.event_id]);
        break;
      }
    }
    return "";
  }

  if (!fullResponse.trim()) {
    if (surfacedTimeout && lastLlmErrorMessage) {
      fullResponse = lastLlmErrorMessage;
    } else {
      const code =
        lastStreamReason === "error"
          ? "LLM_STREAM_ERROR"
          : lastStreamReason === "aborted"
            ? "LLM_ABORTED"
            : "LLM_EMPTY_RESPONSE";
      if (lastStreamReason !== "error" && lastStreamReason !== "aborted") {
        llmLogger.warn("LLM returned no text content", {
          code: "LLM_EMPTY_RESPONSE",
          details: { model: activeModelName, provider: activeProviderName, reason: lastStreamReason },
        });
      }
      const fallback = formatUserFacingLlmError({
        reason: lastStreamReason,
        llmMessage: lastLlmErrorMessage,
        model: activeModelName,
        provider: activeProviderName,
      });
      const errorEntry: LogEntry = {
        level: lastStreamReason === "error" ? "error" : "warn",
        domain: "llm",
        message: lastLlmErrorMessage ?? "No text content in LLM response",
        code,
        details: { model: activeModelName, provider: activeProviderName, reason: lastStreamReason },
      };
      s.onError?.(errorEntry);
      s.onFallback?.(fallback);
      // For errors, append a graceful message to the transcript instead of the raw error.
      // The fallback (with raw error details) is still shown to the user via onFallback.
      if (lastStreamReason === "error") {
        fullResponse = "I encountered an error while processing your request. Please try again.";
      } else {
        fullResponse = fallback;
      }
    }
  }

  // 6. Append agent_message.
  session.eventLog.append({
    kind: "agent_message",
    actor: "agent",
    payload: { text: fullResponse },
  });

  const turnInputTokens = providerUsage?.input ?? promptMetrics.totalTokens;
  const turnOutputTokens = providerUsage?.output ?? estimateTokens(fullResponse);
  if (!recordedProviderUsage) {
    session.recordInputTokens(turnInputTokens);
    session.recordOutputTokens(turnOutputTokens);
  }

  // 6b. Backfill deferred distillations and persist ledger + turn digest
  if (session.contextEngine && stateBeforeTurn) {
    await session.contextEngine.flushDeferredDistillation();
    const turnRecord = turnRecorder.toRecord(
      fullResponse,
      session.getTurnCount(),
      turnInputTokens + turnOutputTokens,
    );
    session.contextEngine.appendTurn(turnRecord);
    session.contextEngine.processTurnExtraction({
      userMessage: userInput,
      record: turnRecord,
      stateBefore: stateBeforeTurn,
      stateGraph: session.stateGraph,
    });
  }

  // 7. Increment turn and run tier management (engine mode only)
  session.incrementTurn();
  session.clearResumed?.();
  session.scorecard.inc("totalTurns");
  session.scorecard.persistProgress();
  if (!classicMode) {
    applyTierManagement(session);
    session.skillRuntime?.cleanupStaleSkills(session.getTurnCount());
    flushSkillTelemetry(session);
  }
  session.persistStateGraphCheckpoint();
  await session.hooks.runPostTurn({ session, turn: session.getTurnCount() });

  // 8. Memory banner — count recall calls & hits from this turn's events
  commitTurnContextDisplay(session, s, {
    contextWindowTokens,
    engineMode: useEngineCompiler,
    historyTokens: turnHistoryTokens,
    distillerSavingsTurn: turnDistillerSavings,
  });
  const stats = computeMemoryStats(session, autoHydrated.length, turnInputTokens, turnOutputTokens);
  stats.nudge = buildScorecardNudge(
    nudgeStart,
    snapshotScorecardNudge(session, noOpToolsThisTurn),
    stats.recallCalls,
    stats.recallHits,
  );
  s.onMemoryBanner?.(stats);

  return fullResponse;
}

async function finalizeInterruptedTurn(
  session: Session,
  partialResponse: string,
  autoHydrated: number,
  promptTokens: number,
  turnRecorder: TurnRecorder,
  userInput: string,
  stateBeforeTurn: ReturnType<ContextEngine["captureStateSnapshot"]> | undefined,
  classicMode: boolean,
  sink?: TurnUiSink,
  providerUsage: ProviderUsage | null = null,
  recordedProviderUsage = false,
): Promise<never> {
  const trimmed = partialResponse.trim();
  const messageText = trimmed
    ? `${trimmed}\n\n[interrupted]`
    : "[interrupted]";
  const turnInputTokens = providerUsage?.input ?? promptTokens;
  const turnOutputTokens = providerUsage?.output ?? estimateTokens(trimmed);

  session.eventLog.append({
    kind: "system_note",
    actor: "kernel",
    payload: { type: "turn_interrupted", partial: trimmed.length > 0 },
  });

  session.eventLog.append({
    kind: "agent_message",
    actor: "agent",
    payload: { text: messageText },
  });

  if (!recordedProviderUsage) {
    session.recordInputTokens(turnInputTokens);
    session.recordOutputTokens(turnOutputTokens);
  }

  if (session.contextEngine && stateBeforeTurn) {
    void session.contextEngine.flushDeferredDistillation();
    const turnRecord = turnRecorder.toRecord(
      messageText,
      session.getTurnCount(),
      turnInputTokens + turnOutputTokens,
    );
    session.contextEngine.appendTurn(turnRecord);
    session.contextEngine.processTurnExtraction({
      userMessage: userInput,
      record: turnRecord,
      stateBefore: stateBeforeTurn,
      stateGraph: session.stateGraph,
    });
  }

  session.incrementTurn();
  session.clearResumed?.();
  session.scorecard.inc("totalTurns");
  session.scorecard.persistProgress();
  if (!classicMode) {
    applyTierManagement(session);
    session.skillRuntime?.cleanupStaleSkills(session.getTurnCount());
    flushSkillTelemetry(session);
  }
  session.persistStateGraphCheckpoint();
  await session.hooks.runPostTurn({ session, turn: session.getTurnCount() });

  const stats = computeMemoryStats(session, autoHydrated, turnInputTokens, turnOutputTokens);
  if (sink) sink.onMemoryBanner?.(stats);
  else printMemoryBanner(stats);

  throw new TurnAbortedError(trimmed);
}

function flushSkillTelemetry(session: Session): void {
  const events = session.skillRuntime?.drainEvents();
  if (!events?.length) return;

  for (const event of events) {
    session.eventLog.append({
      kind: "system_note",
      actor: "kernel",
      payload: { type: "skill_telemetry", event },
    });
  }
}

export function isZodSchema(schema: unknown): schema is ZodType {
  return !!schema && typeof schema === "object" && "_zod" in (schema as Record<string, unknown>);
}

export function normalizeToolParameters(schema: unknown): Record<string, unknown> {
  if (isZodSchema(schema)) {
    // Keep the schema the model sees identical to what zod 3 produced: ordinary
    // objects reject unknown properties, and integers carry no implicit
    // safe-integer bounds (zod 4 adds `minimum`/`maximum` for every `.int()`).
    // Applied per schema node through `override`, so only z.object() nodes and
    // integers are touched (not enum/default payloads, loose objects or records).
    const json = z.toJSONSchema(schema, {
      target: "draft-7",
      io: "input",
      unrepresentable: "any",
      override: ({ zodSchema, jsonSchema }) => {
        const def = (zodSchema as { _zod: { def: { type: string; catchall?: unknown } } })._zod.def;
        if (def.type === "object" && def.catchall === undefined) {
          jsonSchema.additionalProperties = false;
        }
        if (jsonSchema.type === "integer") {
          if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
          if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum;
        }
      },
    }) as Record<string, unknown>;
    delete json.$schema;
    delete json.$ref;
    delete json.definitions;
    delete json.$defs;
    return json;
  }

  return {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
}

export function applyTierManagement(session: Session): void {
  const { idle_soft_after_turns, idle_hard_after_turns } =
    session.config.tiers;
  const sg = session.stateGraph;
  const currentTurn = sg.getTurnCount();

  for (const obj of sg.getActive()) {
    const touchedTurn = sg.getTouchedTurn(obj.id);
    const idleTurns = currentTurn - touchedTurn;
    if (idleTurns >= idle_hard_after_turns) {
      sg.setTier(obj.id, "hard");
    } else if (idleTurns >= idle_soft_after_turns) {
      sg.setTier(obj.id, "soft");
    }
  }

  for (const obj of sg.getPeripheral()) {
    if (obj.tier !== "soft") continue;
    const touchedTurn = sg.getTouchedTurn(obj.id);
    const idleTurns = currentTurn - touchedTurn;
    if (idleTurns >= idle_hard_after_turns) {
      sg.setTier(obj.id, "hard");
    }
  }
}

export interface MemoryBannerStats {
  activeState: number;
  totalState: number;
  digestLen: number;
  recallCalls: number;
  recallHits: number;
  autoHydrated: number;
  promptTokens: number;
  outputTokens: number;
  /** Session-scoped scorecard repeat_file_reads (for footer nudge). */
  repeatFileReads?: number;
  /** Session-scoped churn interventions (issue #571, for footer nudge). */
  churnInterventions?: number;
  /** Per-turn tip when scorecard signals fire this turn (issue #549 / #571). */
  nudge?: string;
}

function commitTurnContextDisplay(
  session: Session,
  sink: TurnUiSink,
  input: {
    contextWindowTokens: number;
    engineMode: boolean;
    historyTokens: number;
    distillerSavingsTurn: number;
  },
): void {
  const built = buildContextDisplaySnapshot({
    session,
    contextWindowTokens: input.contextWindowTokens,
    engineMode: input.engineMode,
    historyTokens: input.historyTokens,
    distillerSavingsTurn: input.distillerSavingsTurn,
  });
  const snapshot = maxContextSnapshot(built, sink.getContextPreview?.());
  session.setDisplayContextSnapshot(snapshot);
  sink.onTurnContextCommit?.(snapshot);
}

export function computeMemoryStats(
  session: Session,
  autoHydrated: number,
  promptTokens?: number,
  outputTokens?: number,
): MemoryBannerStats {
  const memStats = session.getMemoryStats();
  // Boundary-aware: after /clear, only count recalls from the current epoch so
  // the memory banner doesn't surface pre-clear recall telemetry.
  const recentEvents = session.eventLog.readLastUncompressedAfterResetBoundary(50);
  let recallCalls = 0;
  let recallHits = 0;
  for (const ev of recentEvents) {
    if (ev.kind === "system_note" && (ev.payload.type as string) === "memory_recall") {
      recallCalls++;
      recallHits += (ev.payload.hits as number) ?? 0;
    }
  }
  return {
    activeState: memStats.active,
    totalState: memStats.total,
    digestLen: session.digest?.length ?? 0,
    recallCalls,
    recallHits,
    autoHydrated,
    promptTokens: promptTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    repeatFileReads: session.scorecard?.getCounters?.().repeatFileReads ?? 0,
    churnInterventions: session.scorecard?.getCounters?.().churnInterventions ?? 0,
  };
}

function toolResultRawText(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

function toolCommandFromArgs(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName === "git_diff") {
    const parts: string[] = [];
    if (args.staged === true) parts.push("staged");
    if (typeof args.path === "string" && args.path.length > 0) parts.push(args.path);
    return parts.length > 0 ? parts.join(" ") : "unstaged";
  }
  if (toolName === "git_status") return "status";
  if (toolName === "git_commit") {
    return typeof args.message === "string" ? args.message.slice(0, 80) : "commit";
  }
  if (
    toolName === "code_definition" ||
    toolName === "code_references"
  ) {
    const symbol = typeof args.symbol === "string" ? args.symbol : "";
    const root = typeof args.root === "string" ? args.root : ".";
    return symbol ? `${symbol} @ ${root}` : root;
  }
  if (
    toolName === "lsp_hover" ||
    toolName === "lsp_completions" ||
    toolName === "lsp_definition" ||
    toolName === "lsp_references"
  ) {
    const path = typeof args.path === "string" ? args.path : "";
    const line = args.line;
    const col = args.col;
    return path ? `${path}:${line}:${col}` : undefined;
  }
  if (toolName === "lsp_code_actions") {
    const path = typeof args.path === "string" ? args.path : "";
    return path
      ? `${path}:${args.startLine}:${args.startCol}-${args.endLine}:${args.endCol}`
      : undefined;
  }
  if (toolName === "lsp_apply_code_action") {
    return typeof args.id === "string" ? args.id : undefined;
  }
  if (
    toolName === "code_parse" ||
    toolName === "code_imports" ||
    toolName === "code_symbols" ||
    toolName === "lsp_diagnostics" ||
    toolName === "lsp_format"
  ) {
    return typeof args.path === "string" ? args.path : undefined;
  }
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.query === "string") return args.query;
  if (toolName === "shell" && typeof args.command === "string") return args.command;
  return undefined;
}

/** Prefer absolute paths for read_file so artifact file-read index matches interceptor. */
function resolveToolCommand(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string | undefined {
  const raw = toolCommandFromArgs(toolName, args);
  if (!raw) return undefined;
  if (toolName === "read_file") {
    return isAbsolute(raw) ? raw : resolve(cwd, raw);
  }
  return raw;
}
