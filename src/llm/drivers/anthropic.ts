// ============================================================
// PRAANA — Anthropic Messages Native Wire Protocol Driver
// Direct REST + SSE Streaming with Prompt Caching & Extended Thinking
// ============================================================

import type { LlmDriver } from "./base.js";
import type {
  StreamRequest,
  StreamEvent,
  ResolvedAuth,
  ConversationMessage,
  ToolDefinition,
  AssistantMessage,
  ToolCall,
} from "../types.js";
import { parseSseStream } from "../sse.js";
import { ToolCallAccumulator } from "../tool-accumulator.js";
import { runGuardedProviderStream } from "../stream-guard.js";
import { logLenientStreamEnd, prematureEndError, toolCutoffError } from "../stream-end.js";

const ANTHROPIC_ERROR_STATUSES: Record<string, number> = {
  overloaded_error: 529,
  rate_limit_error: 429,
  api_error: 500,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  invalid_request_error: 400,
  request_too_large: 413,
};

type ThinkingMode = "adaptive" | "budget";
const learnedThinkingModes = new Map<string, ThinkingMode>();

function anthropicThinkingMode(modelId: string): ThinkingMode {
  const match = /^claude-(?:[a-z]+-)?(\d+)-/i.exec(modelId);
  return match && Number(match[1]) >= 5 ? "adaptive" : "budget";
}

export class AnthropicDriver implements LlmDriver {
  readonly protocol = "anthropic-messages";

  async *stream(req: StreamRequest, auth: ResolvedAuth): AsyncIterable<StreamEvent> {
    const baseUrl = req.baseUrl || auth.baseUrl || "https://api.anthropic.com";
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31,max-tokens-3-5-sonnet-2024-07-15",
      ...(auth.apiKey ? { "x-api-key": auth.apiKey } : {}),
      ...(auth.bearerToken ? { Authorization: `Bearer ${auth.bearerToken}` } : {}),
      ...(req.headers || {}),
      ...(auth.headers || {}),
    };

    const { system, messages } = this.formatMessages(req.messages, req.systemPrompt);
    const tools = this.formatTools(req.tools);

    const maxTokens = req.maxTokens ?? 8192;
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: maxTokens,
      stream: true,
      ...(system ? { system } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    const thinkingOn = !!req.reasoningEffort && req.reasoningEffort !== "off";
    let mode = learnedThinkingModes.get(req.model) ?? anthropicThinkingMode(req.model);
    const applyThinking = () => {
      if (!thinkingOn) return;
      delete body.temperature;
      if (mode === "adaptive") {
        body.thinking = { type: "adaptive" };
        body.output_config = { effort: req.reasoningEffort === "medium" ? "medium" : req.reasoningEffort === "high" || req.reasoningEffort === "xhigh" ? "high" : "low" };
        body.max_tokens = maxTokens;
      } else {
        const budgetTokens = req.reasoningEffort === "high" ? 8192 : req.reasoningEffort === "medium" ? 4096 : 2048;
        body.thinking = { type: "enabled", budget_tokens: budgetTokens };
        body.max_tokens = Math.max(maxTokens, budgetTokens + 4096);
        delete body.output_config;
      }
    };
    applyThinking();
    let switched = false;

    const accumulator = new ToolCallAccumulator();
    let accumulatedContent = "";
    let accumulatedThinking = "";
    let thinkingSignature: string | undefined;
    let finishReason: (Extract<StreamEvent, { type: "done" }>)["reason"] = "stop";

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

    let currentBlockIndex = -1;
    let stopReason: string | undefined;
    let sawTerminal = false;
    let emittedDelta = false;

    const haltedMessage = (): AssistantMessage => ({
      role: "assistant",
      content: accumulatedContent,
      thinking: accumulatedThinking || undefined,
      thinkingSignature,
      toolCalls: [],
    });

    yield* runGuardedProviderStream({
      req,
      haltedMessage,
      retryForm: (status, text) => {
        const alternate = mode === "budget" ? /thinking\.type\.adaptive/i.test(text) : /adaptive.{0,80}not supported|not supported.{0,80}adaptive/i.test(text);
        if (status !== 400 || !thinkingOn || switched || !alternate) return false;
        switched = true;
        mode = mode === "budget" ? "adaptive" : "budget";
        learnedThinkingModes.set(req.model, mode);
        applyThinking();
        return true;
      },
      httpErrorLabel: "Anthropic API error",
      emptyBodyMessage: "Empty response body from Anthropic endpoint",
      request: (guard) =>
        guard.fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      frames: (byteStream) => parseSseStream(byteStream),
      onFrame: (event) => {
        const events: StreamEvent[] = [];
        let terminal = false;
        const dataStr = event.data?.trim();
        if (!dataStr) return { events };

        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          return { events };
        }

        const type = parsed.type;

        if (event.event === "error" || type === "error") {
          const errBody = parsed.error ?? {};
          const errType = typeof errBody.type === "string" ? errBody.type : "";
          const message =
            typeof errBody.message === "string" && errBody.message
              ? errBody.message
              : "Anthropic stream error";
          const status = typeof errBody.status === "number" ? errBody.status : ANTHROPIC_ERROR_STATUSES[errType];
          events.push({
            type: "error",
            error: new Error(message),
            status,
            retryable: false,
          });
          return { events, stop: true };
        }

        if (type === "message_start") {
          const usage = parsed.message?.usage;
          if (usage) {
            inputTokens += usage.input_tokens ?? 0;
            cacheReadTokens += usage.cache_read_input_tokens ?? 0;
            cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
          }
        } else if (type === "content_block_start") {
          currentBlockIndex = parsed.index ?? 0;
          const block = parsed.content_block;
          if (block?.type === "tool_use") {
            const res = accumulator.processChunk({
              index: currentBlockIndex,
              id: block.id,
              name: block.name,
            });
            if (res.started) {
              emittedDelta = true;
              events.push({ type: "tool_call_start", id: res.started.id, name: res.started.name });
            }
          }
        } else if (type === "content_block_delta") {
          const delta = parsed.delta;
          if (!delta) return { events };

          if (delta.type === "text_delta") {
            accumulatedContent += delta.text;
            emittedDelta = true;
            events.push({ type: "text_delta", delta: delta.text });
          } else if (delta.type === "thinking_delta") {
            accumulatedThinking += delta.thinking;
            emittedDelta = true;
            events.push({ type: "thinking_delta", delta: delta.thinking });
          } else if (delta.type === "signature_delta") {
            thinkingSignature = (thinkingSignature || "") + delta.signature;
          } else if (delta.type === "input_json_delta") {
            const res = accumulator.processChunk({
              index: currentBlockIndex,
              argsDelta: delta.partial_json,
            });
            if (res.delta) {
              emittedDelta = true;
              events.push({ type: "tool_call_delta", id: res.delta.id, argsDelta: res.delta.argsDelta });
            }
          }
        } else if (type === "message_delta") {
          const delta = parsed.delta;
          if (delta?.stop_reason) {
            sawTerminal = true;
            terminal = true;
            stopReason = delta.stop_reason;
            if (delta.stop_reason === "tool_use") finishReason = "tool_use";
            else if (delta.stop_reason === "max_tokens" || delta.stop_reason === "model_context_window_exceeded") finishReason = "length";
            else finishReason = "stop";
          }
          const usage = parsed.usage;
          if (usage) {
            outputTokens += usage.output_tokens ?? 0;
          }
        } else if (type === "message_stop") {
          sawTerminal = true;
          terminal = true;
        }
        if (terminal) return { events: [...events, ...finishAnthropic()], stop: true };
        return { events };
      },
      onComplete: () => finishAnthropic(),
    });

    function finishAnthropic(): StreamEvent[] {
        const events: StreamEvent[] = [];
        let lenientCalls: ToolCall[] | undefined;
        if (!sawTerminal) {
          if (req.strictStreamEnd !== false) {
            events.push(prematureEndError("message_stop", !emittedDelta));
            return events;
          }
          const flushed = accumulator.flush({ allowRepair: false });
          if (flushed.droppedIds.length > 0) return [toolCutoffError()];
          logLenientStreamEnd(req.provider);
          lenientCalls = flushed.calls;
        }

        const usageEvent: StreamEvent = {
          type: "usage",
          usage: {
            input: inputTokens,
            output: outputTokens,
            totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
            cacheReadTokens,
            cacheWriteTokens,
          },
        };

        // A refusal that produced no text must not look like an empty stop.
        // A refusal that did produce text stays a normal stop below.
        // Usage is reported either way; the early return used to skip it.
        if (stopReason === "refusal" && accumulatedContent.trim() === "") {
          events.push(usageEvent);
          events.push({
            type: "error",
            error: new Error("The model declined to answer"),
            retryable: false,
          });
          return events;
        }

        events.push(usageEvent);

        // Block completion alone does not authorize a tool; wait for the message terminal.
        const normalStop = stopReason === undefined || ["tool_use", "end_turn", "stop_sequence", "pause_turn"].includes(stopReason);
        const completedToolCalls = lenientCalls ?? (normalStop ? accumulator.flush().calls : []);
        if (completedToolCalls.length > 0) {
          finishReason = "tool_use";
          for (const tc of completedToolCalls) {
            events.push({ type: "tool_call_end", toolCall: tc });
          }
        }

        const finalAssistant: AssistantMessage = {
          role: "assistant",
          content: accumulatedContent,
          thinking: accumulatedThinking || undefined,
          thinkingSignature: thinkingSignature || undefined,
          toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
        };

        events.push({
          type: "done",
          reason: finishReason,
          message: finalAssistant,
        });
        return events;
    }
  }

  private formatMessages(
    messages: ConversationMessage[],
    systemPrompt?: string,
  ): {
    system?: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    messages: Array<Record<string, unknown>>;
  } {
    let system: Array<{ type: string; text: string; cache_control?: { type: string } }> | undefined;
    if (systemPrompt) {
      system = [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ];
    }

    const formatted: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        // Additional system messages appended to system block
        if (!system) system = [];
        system.push({ type: "text", text: msg.content });
      } else if (msg.role === "user") {
        if (typeof msg.content === "string") {
          formatted.push({ role: "user", content: msg.content });
        } else {
          const parts = msg.content.map((p) => {
            if (p.type === "text") return { type: "text", text: p.text };
            if (p.type === "image") {
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: p.mimeType,
                  data: p.data,
                },
              };
            }
            return { type: "text", text: "" };
          });
          formatted.push({ role: "user", content: parts });
        }
      } else if (msg.role === "assistant") {
        const contentParts: Array<Record<string, unknown>> = [];

        // Preserve thinking block and signature if present
        if (msg.thinking && msg.thinkingSignature) {
          contentParts.push({
            type: "thinking",
            thinking: msg.thinking,
            signature: msg.thinkingSignature,
          });
        }

        if (msg.content) {
          contentParts.push({ type: "text", text: msg.content });
        }

        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            contentParts.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.args,
            });
          }
        }

        formatted.push({
          role: "assistant",
          content: contentParts.length > 0 ? contentParts : msg.content || "",
        });
      } else if (msg.role === "tool_result") {
        // Tool results are sent under user role in Anthropic Messages API
        formatted.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId,
              content: msg.result,
              ...(msg.isError ? { is_error: true } : {}),
            },
          ],
        });
      }
    }

    return { system, messages: formatted };
  }

  private formatTools(tools?: ToolDefinition[]): Array<Record<string, unknown>> {
    if (!tools || tools.length === 0) return [];
    return tools.map((t, idx) => {
      const toolObj: Record<string, unknown> = {
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      };
      // Mark the last tool definition with ephemeral cache control
      if (idx === tools.length - 1) {
        toolObj.cache_control = { type: "ephemeral" };
      }
      return toolObj;
    });
  }
}
