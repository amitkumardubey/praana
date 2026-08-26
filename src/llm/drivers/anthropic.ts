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
import { withPreEmissionRetry } from "../retry.js";

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

    if (req.reasoningEffort && req.reasoningEffort !== "off") {
      const budgetTokens = req.reasoningEffort === "high" ? 8192 : req.reasoningEffort === "medium" ? 4096 : 2048;
      body.thinking = { type: "enabled", budget_tokens: budgetTokens };
      // When thinking is enabled, Anthropic requires max_tokens > budget_tokens and temperature: 1.0 (or omitted)
      body.max_tokens = Math.max(maxTokens, budgetTokens + 4096);
      delete body.temperature;
    }

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
            const err: any = new Error(`Anthropic API error (${res.status}): ${errText}`);
            err.status = res.status;
            throw err;
          }

          if (!res.body) {
            throw new Error("Empty response body from Anthropic endpoint");
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
    let thinkingSignature: string | undefined;
    let finishReason: (Extract<StreamEvent, { type: "done" }>)["reason"] = "stop";

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

    let currentBlockIndex = -1;
    let currentBlockType: string | null = null;

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
              thinkingSignature,
              toolCalls: accumulator.flush(),
            },
          };
          return;
        }

        const dataStr = event.data?.trim();
        if (!dataStr) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        const type = parsed.type;

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
          currentBlockType = block?.type ?? null;

          if (currentBlockType === "tool_use") {
            const res = accumulator.processChunk({
              index: currentBlockIndex,
              id: block.id,
              name: block.name,
            });
            if (res.started) {
              yield { type: "tool_call_start", id: res.started.id, name: res.started.name };
            }
          }
        } else if (type === "content_block_delta") {
          const delta = parsed.delta;
          if (!delta) continue;

          if (delta.type === "text_delta") {
            accumulatedContent += delta.text;
            yield { type: "text_delta", delta: delta.text };
          } else if (delta.type === "thinking_delta") {
            accumulatedThinking += delta.thinking;
            yield { type: "thinking_delta", delta: delta.thinking };
          } else if (delta.type === "signature_delta") {
            thinkingSignature = (thinkingSignature || "") + delta.signature;
          } else if (delta.type === "input_json_delta") {
            const res = accumulator.processChunk({
              index: currentBlockIndex,
              argsDelta: delta.partial_json,
            });
            if (res.delta) {
              yield { type: "tool_call_delta", id: res.delta.id, argsDelta: res.delta.argsDelta };
            }
          }
        } else if (type === "content_block_stop") {
          if (currentBlockType === "tool_use") {
            accumulator.processChunk({
              index: currentBlockIndex,
              isComplete: true,
            });
          }
          currentBlockType = null;
        } else if (type === "message_delta") {
          const delta = parsed.delta;
          if (delta?.stop_reason) {
            if (delta.stop_reason === "tool_use") finishReason = "tool_use";
            else if (delta.stop_reason === "max_tokens") finishReason = "length";
            else finishReason = "stop";
          }
          const usage = parsed.usage;
          if (usage) {
            outputTokens += usage.output_tokens ?? 0;
          }
        }
      }

      // Emit normalized usage
      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
      yield {
        type: "usage",
        usage: {
          input: inputTokens,
          output: outputTokens,
          totalTokens,
          cacheReadTokens,
          cacheWriteTokens,
        },
      };

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
        thinkingSignature: thinkingSignature || undefined,
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
