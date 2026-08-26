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
import { withPreEmissionRetry } from "../retry.js";

export class OpenAICompatibleDriver implements LlmDriver {
  readonly protocol: string = "openai-compatible";

  async *stream(req: StreamRequest, auth: ResolvedAuth): AsyncIterable<StreamEvent> {
    const baseUrl = req.baseUrl || auth.baseUrl || "https://api.openai.com/v1";
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
      ...(auth.bearerToken ? { Authorization: `Bearer ${auth.bearerToken}` } : {}),
      ...(req.headers || {}),
      ...(auth.headers || {}),
    };

    const messages = this.formatMessages(req.messages, req.systemPrompt);
    const tools = this.formatTools(req.tools);

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    };

    if (req.reasoningEffort && req.reasoningEffort !== "off") {
      body.reasoning_effort = req.reasoningEffort;
    }

    // Execute HTTP request with pre-emission retry safety
    let response: Response;
    try {
      response = await withPreEmissionRetry(
        async () => {
          const res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: req.signal,
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            const err: any = new Error(`OpenAI API error (${res.status}): ${errText}`);
            err.status = res.status;
            throw err;
          }

          if (!res.body) {
            throw new Error("Empty response body from OpenAI endpoint");
          }

          return res;
        },
        { signal: req.signal },
      );
    } catch (err: any) {
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
        status: err.status,
        retryable: false,
      };
      return;
    }

    const accumulator = new ToolCallAccumulator();
    let accumulatedContent = "";
    let accumulatedThinking = "";
    let finishReason: (Extract<StreamEvent, { type: "done" }>)["reason"] = "stop";
    let latestUsage: (Extract<StreamEvent, { type: "usage" }>)["usage"] | null = null;

    try {
      for await (const event of parseSseStream(response.body!)) {
        if (req.signal?.aborted) {
          yield {
            type: "done",
            reason: "abort",
            message: {
              role: "assistant",
              content: accumulatedContent,
              thinking: accumulatedThinking || undefined,
              toolCalls: accumulator.flush(),
            },
          };
          return;
        }

        const dataStr = event.data?.trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        // Usage chunk
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
          yield { type: "usage", usage: latestUsage };
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          if (choice.finish_reason === "tool_calls") finishReason = "tool_use";
          else if (choice.finish_reason === "length") finishReason = "length";
          else finishReason = "stop";
        }

        const delta = choice.delta;
        if (!delta) continue;

        // Reasoning / Thinking delta (DeepSeek, Groq, etc.)
        if (delta.reasoning_content) {
          accumulatedThinking += delta.reasoning_content;
          yield { type: "thinking_delta", delta: delta.reasoning_content };
        }

        // Text delta
        if (delta.content) {
          accumulatedContent += delta.content;
          yield { type: "text_delta", delta: delta.content };
        }

        // Tool call chunks
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
              yield { type: "tool_call_start", id: res.started.id, name: res.started.name };
            }
            if (res.delta) {
              yield { type: "tool_call_delta", id: res.delta.id, argsDelta: res.delta.argsDelta };
            }
          }
        }
      }

      const completedToolCalls = accumulator.flush();
      if (completedToolCalls.length > 0) {
        finishReason = "tool_use";
        for (const tc of completedToolCalls) {
          yield { type: "tool_call_end", toolCall: tc };
        }
      }

      const finalAssistant: AssistantMessage = {
        role: "assistant",
        content: accumulatedContent,
        thinking: accumulatedThinking || undefined,
        toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
      };

      yield {
        type: "done",
        reason: finishReason,
        message: finalAssistant,
      };
    } catch (err: any) {
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
        status: err.status,
        retryable: false,
      };
    }
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
