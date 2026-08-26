// ============================================================
// PRAANA — Native LLM Types & Streaming Contracts
// ============================================================

/** Content parts supported in multimodal/extended conversation messages. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string } // base64
  | { type: "thinking"; thinking: string; signature?: string };

/** Canonical tool call structure across all model architectures. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  rawArgs?: string;
}

/** Canonical assistant message produced by the model. */
export interface AssistantMessage {
  role: "assistant";
  content: string;
  thinking?: string;
  thinkingSignature?: string;
  toolCalls?: ToolCall[];
}

/** Canonical conversation message model for history and turns. */
export type ConversationMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | AssistantMessage
  | {
      role: "tool_result";
      toolCallId: string;
      toolName: string;
      result: string; // Deterministically serialized string
      isError?: boolean;
    };

/** Unified tool parameter definition passed to model drivers. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** Normalized token and cache accounting. */
export interface ProviderUsage {
  input: number;
  output: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Pure streaming event taxonomy emitted by all LLM drivers. */
export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argsDelta: string }
  | { type: "tool_call_end"; toolCall: ToolCall }
  | {
      type: "usage";
      usage: ProviderUsage;
    }
  | {
      type: "done";
      reason: "stop" | "tool_use" | "length" | "abort" | "error" | "rate_limit" | "timeout";
      message: AssistantMessage;
    }
  | { type: "error"; error: Error; status?: number; retryable: boolean };

import type { ProviderWireCompat } from "../provider-registry.js";

/** Resolved credentials passed to drivers. */
export interface ResolvedAuth {
  apiKey?: string;
  bearerToken?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
  isKeyless?: boolean;
  /** Ambient AWS chain (profile / IRSA / container) — resolve at request time. */
  awsAmbient?: boolean;
  /** Vertex ADC via GOOGLE_APPLICATION_CREDENTIALS — mint at request time. */
  googleAdc?: boolean;
}

/** Inbound request passed to LLM drivers. */
export interface StreamRequest {
  model: string;
  provider: string;
  systemPrompt?: string;
  messages: ConversationMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  reasoningEffort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: ProviderWireCompat;
  region?: string;
  api?: string;
  query?: Record<string, string>;
  /** Absolute URL; when set, drivers skip baseUrl+path construction. */
  endpointUrl?: string;
  /** Request-level credential overlay (OAuth refresh / RuntimeModel). */
  apiKey?: string;
  bearerToken?: string;
}

/** Aggregated result of an LLM turn stream. */
export interface StreamResult {
  fullResponse: string;
  thinking: string;
  thinkingSignature?: string;
  pendingToolCalls: ToolCall[];
  finalMessage: AssistantMessage | null;
  finalReason: "stop" | "tool_use" | "length" | "abort" | "error" | "rate_limit" | "timeout";
  errorMessage?: string;
  providerUsage: ProviderUsage | null;
  assistantTokens: number;
  interrupted: boolean;
}
