// ============================================================
// PRAANA — OpenAI-Compatible Wire Protocol Driver
// Covers: OpenAI, OpenRouter, DeepSeek, Groq, Ollama, custom
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
import { logLenientStreamEnd } from "../stream-end.js";
import { joinUrl } from "../url.js";

export class OpenAICompatibleDriver implements LlmDriver {
  readonly protocol: string = "openai-compatible";

  async *stream(req: StreamRequest, auth: ResolvedAuth): AsyncIterable<StreamEvent> {
    const baseUrl = req.baseUrl || auth.baseUrl || "https://api.openai.com/v1";
    const endpoint =
      req.endpointUrl || joinUrl(baseUrl, "/chat/completions", req.query);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
      ...(auth.bearerToken ? { Authorization: `Bearer ${auth.bearerToken}` } : {}),
      ...(req.headers || {}),
      ...(auth.headers || {}),
    };

    const messages = this.formatMessages(req.messages, req.systemPrompt);
    const tools = this.formatTools(req.tools);
    const compat = req.compat;
    const maxTokensField = compat?.maxTokensField ?? "max_tokens";

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { [maxTokensField]: req.maxTokens } : {}),
    };

    if (compat?.supportsUsageInStreaming !== false) {
      body.stream_options = { include_usage: true };
    }

    if (
      compat?.supportsReasoningEffort !== false &&
      req.reasoningEffort &&
      req.reasoningEffort !== "off"
    ) {
      body.reasoning_effort = req.reasoningEffort;
    }

    if (compat?.thinkingFormat === "qwen-chat-template" && req.reasoningEffort && req.reasoningEffort !== "off") {
      body.chat_template_kwargs = {
        ...(compat.chatTemplateKwargs ?? {}),
        enable_thinking: true,
      };
    }

    const accumulator = new ToolCallAccumulator();
    let accumulatedContent = "";
    let accumulatedThinking = "";
    let finishReason: (Extract<StreamEvent, { type: "done" }>)["reason"] = "stop";
    let latestUsage: (Extract<StreamEvent, { type: "usage" }>)["usage"] | null = null;
    let sawTerminal = false;
    let emittedDelta = false;

    const haltedMessage = (): AssistantMessage => ({
      role: "assistant",
      content: accumulatedContent,
      thinking: accumulatedThinking || undefined,
      toolCalls: accumulator.flush(),
    });

    yield* runGuardedProviderStream({
      req,
      haltedMessage,
      httpErrorLabel: "OpenAI API error",
      emptyBodyMessage: "Empty response body from OpenAI endpoint",
      request: (guard) =>
        guard.fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      frames: (byteStream) => parseSseStream(byteStream),
      onFrame: (event) => {
        const events: StreamEvent[] = [];
        const dataStr = event.data?.trim();
        if (!dataStr || dataStr === "[DONE]") {
          if (dataStr === "[DONE]") sawTerminal = true;
          return { events };
        }

        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          return { events };
        }

        if (parsed.error && !Array.isArray(parsed.choices)) {
          const errBody = parsed.error;
          const message =
            typeof errBody.message === "string" && errBody.message
              ? errBody.message
              : "OpenAI stream error";
          let status: number | undefined;
          if (typeof errBody.code === "number") status = errBody.code;
          else if (typeof errBody.status === "number") status = errBody.status;
          else {
            const code = String(errBody.code ?? errBody.type ?? "");
            if (/rate_limit|insufficient_quota/.test(code)) status = 429;
            else if (/server_error|internal_error/.test(code)) status = 500;
          }
          events.push({
            type: "error",
            error: new Error(message),
            status,
            retryable: false,
          });
          return { events, stop: true };
        }

        if (parsed.usage) {
          latestUsage = {
            input: parsed.usage.prompt_tokens ?? 0,
            output: parsed.usage.completion_tokens ?? 0,
            totalTokens: parsed.usage.total_tokens ?? 0,
            cacheReadTokens:
              parsed.usage.prompt_tokens_details?.cached_tokens ??
              parsed.usage.prompt_cache_hit_tokens ??
              0,
            cacheWriteTokens: parsed.usage.prompt_cache_miss_tokens ?? 0,
          };
          events.push({ type: "usage", usage: latestUsage });
        }

        const choice = parsed.choices?.[0];
        if (!choice) return { events };

        if (choice.finish_reason) {
          sawTerminal = true;
          if (choice.finish_reason === "tool_calls") finishReason = "tool_use";
          else if (choice.finish_reason === "length") finishReason = "length";
          else finishReason = "stop";
        }

        const delta = choice.delta;
        if (!delta) return { events };

        if (delta.reasoning_content) {
          accumulatedThinking += delta.reasoning_content;
          emittedDelta = true;
          events.push({ type: "thinking_delta", delta: delta.reasoning_content });
        }

        if (delta.content) {
          accumulatedContent += delta.content;
          emittedDelta = true;
          events.push({ type: "text_delta", delta: delta.content });
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            const res = accumulator.processChunk({
              index,
              id: tc.id,
              name: tc.function?.name,
              argsDelta: tc.function?.arguments,
            });

            if (res.started) {
              emittedDelta = true;
              events.push({ type: "tool_call_start", id: res.started.id, name: res.started.name });
            }
            if (res.delta) {
              emittedDelta = true;
              events.push({ type: "tool_call_delta", id: res.delta.id, argsDelta: res.delta.argsDelta });
            }
          }
        }
        return { events };
      },
      onComplete: () => {
        const events: StreamEvent[] = [];
        if (!sawTerminal) {
          if (req.strictStreamEnd !== false) {
            events.push({
              type: "error",
              error: new Error(
                "stream ended before the provider sent a final event (finish_reason or [DONE])",
              ),
              retryable: !emittedDelta,
            });
            return events;
          }
          logLenientStreamEnd(req.provider);
        }

        const completedToolCalls = accumulator.flush();
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
          toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
        };

        events.push({
          type: "done",
          reason: finishReason,
          message: finalAssistant,
        });
        return events;
      },
    });
  }

  private formatMessages(
    messages: ConversationMessage[],
    systemPrompt?: string,
  ): Array<Record<string, unknown>> {
    const formatted: Array<Record<string, unknown>> = [];

    if (systemPrompt) {
      formatted.push({ role: "system", content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === "system") {
        formatted.push({ role: "system", content: msg.content });
      } else if (msg.role === "user") {
        if (typeof msg.content === "string") {
          formatted.push({ role: "user", content: msg.content });
        } else {
          // Multimodal parts
          const parts = msg.content.map((p) => {
            if (p.type === "text") return { type: "text", text: p.text };
            if (p.type === "image") {
              return {
                type: "image_url",
                image_url: { url: `data:${p.mimeType};base64,${p.data}` },
              };
            }
            return { type: "text", text: "" };
          });
          formatted.push({ role: "user", content: parts });
        }
      } else if (msg.role === "assistant") {
        const assistantObj: Record<string, unknown> = {
          role: "assistant",
          content: msg.content || null,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          assistantObj.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: tc.rawArgs || JSON.stringify(tc.args),
            },
          }));
        }
        formatted.push(assistantObj);
      } else if (msg.role === "tool_result") {
        formatted.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.result,
        });
      }
    }

    return formatted;
  }

  private formatTools(tools?: ToolDefinition[]): Array<Record<string, unknown>> {
    if (!tools || tools.length === 0) return [];
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}
