// ============================================================
// PRAANA — OpenAI Responses / Codex Wire Protocol Driver
// Used by openai-codex (chatgpt.com/backend-api) and openai-responses
// ============================================================

import type { LlmDriver } from "./base.js";
import type {
  StreamRequest,
  StreamEvent,
  ResolvedAuth,
  ConversationMessage,
  ToolDefinition,
  AssistantMessage,
  ProviderUsage,
} from "../types.js";
import { parseSseStream } from "../sse.js";
import { ToolCallAccumulator } from "../tool-accumulator.js";
import { withPreEmissionRetry } from "../retry.js";
import { joinUrl } from "../url.js";
import { extractAccountId } from "../../oauth-codex.js";

/** Top-level `usage` or the `response.usage` object sent on completed/incomplete events. */
function readResponsesUsage(parsed: Record<string, unknown>): ProviderUsage | null {
  const response = parsed.response;
  const nested = response && typeof response === "object"
    ? (response as { usage?: unknown }).usage
    : undefined;
  const raw = nested && typeof nested === "object"
    ? nested
    : parsed.usage && typeof parsed.usage === "object"
      ? parsed.usage
      : undefined;
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, number>;
  return {
    input: u.input_tokens ?? u.prompt_tokens ?? 0,
    output: u.output_tokens ?? u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
  };
}

export class OpenAIResponsesDriver implements LlmDriver {
  readonly protocol = "openai-responses";

  async *stream(req: StreamRequest, auth: ResolvedAuth): AsyncIterable<StreamEvent> {
    const defaultBase =
      req.provider === "openai-codex"
        ? "https://chatgpt.com/backend-api"
        : "https://api.openai.com/v1";
    const baseUrl = (req.baseUrl || auth.baseUrl || defaultBase).replace(/\/+$/, "");
    const path = req.provider === "openai-codex" ? "/codex/responses" : "/responses";
    const endpoint = req.endpointUrl || joinUrl(baseUrl, path, req.query);

    let headers: Record<string, string> | Headers = {
      "Content-Type": "application/json",
      ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
      ...(auth.bearerToken ? { Authorization: `Bearer ${auth.bearerToken}` } : {}),
      ...(req.headers || {}),
      ...(auth.headers || {}),
    };
    if (req.provider === "openai-codex") {
      try {
        // Explicit request credentials supersede both stored tokens and their account header.
        const overrideToken = req.bearerToken || req.apiKey;
        const token = overrideToken || auth.bearerToken || auth.apiKey;
        if (!token) throw new Error("OpenAI Codex requires an access token and account id; run /login openai-codex again");
        const accountId = overrideToken
          ? extractAccountId(overrideToken)
          : new Headers(auth.headers).get("chatgpt-account-id")?.trim() || extractAccountId(token);
        // The banner's config imports lead back to this driver; load its version after initialization.
        const { APP_VERSION } = await import("../../app-banner.js");
        const codexHeaders = new Headers(headers);
        codexHeaders.set("Authorization", `Bearer ${token}`);
        codexHeaders.set("chatgpt-account-id", accountId);
        codexHeaders.set("originator", "praana");
        codexHeaders.set("OpenAI-Beta", "responses=experimental");
        codexHeaders.set("Accept", "text/event-stream");
        codexHeaders.set("Content-Type", "application/json");
        codexHeaders.set("User-Agent", `praana/${APP_VERSION.replace(/^v/, "")}`);
        headers = codexHeaders;
      } catch (err: unknown) {
        const e = err as { status?: number };
        yield {
          type: "error",
          error: err instanceof Error ? err : new Error(String(err)),
          status: e.status,
          retryable: false,
        };
        return;
      }
    }

    const { instructions, input } = this.formatInput(req.messages, req.systemPrompt);
    const tools = this.formatTools(req.tools);

    const body: Record<string, unknown> = {
      model: req.model,
      input,
      stream: true,
      ...(req.provider === "openai-codex"
        ? { store: false, instructions: instructions?.trim() ? instructions : "You are a helpful assistant." }
        : instructions ? { instructions } : {}),
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.provider !== "openai-codex" && req.maxTokens !== undefined ? { max_output_tokens: req.maxTokens } : {}),
    };

    if (req.reasoningEffort && req.reasoningEffort !== "off") {
      body.reasoning = { effort: req.reasoningEffort };
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
            const err: Error & { status?: number } = new Error(
              `OpenAI Responses API error (${res.status}): ${errText}`,
            );
            err.status = res.status;
            throw err;
          }
          if (!res.body) throw new Error("Empty response body from Responses endpoint");
          return res;
        },
        { signal: req.signal },
      );
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
        status: e.status,
        retryable: false,
      };
      return;
    }

    const accumulator = new ToolCallAccumulator();
    let accumulatedContent = "";
    let finishReason: Extract<StreamEvent, { type: "done" }>["reason"] = "stop";
    let latestUsage: Extract<StreamEvent, { type: "usage" }>["usage"] | null = null;
    let itemIndex = 0;
    const codex = req.provider === "openai-codex";
    let terminalReceived = false;
    let cappedByLength = false;
    const responsesErrorMessage = (parsed: Record<string, unknown>, type: string): string => {
      const resp = parsed.response as {
        error?: { message?: string };
        incomplete_details?: { message?: string; reason?: string };
      } | undefined;
      const error = parsed.error as { message?: string } | string | undefined;
      const message = resp?.error?.message || resp?.incomplete_details?.message ||
        resp?.incomplete_details?.reason || (typeof error === "string" ? error : error?.message) ||
        (typeof parsed.message === "string" ? parsed.message : undefined);
      return message || `OpenAI Responses stream ${type}`;
    };

    try {
      for await (const event of parseSseStream(response.body!)) {
        if (req.signal?.aborted) {
          yield {
            type: "done",
            reason: "abort",
            message: {
              role: "assistant",
              content: accumulatedContent,
              toolCalls: accumulator.flush(),
            },
          };
          return;
        }

        const dataStr = event.data?.trim();
        if (!dataStr || dataStr === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(dataStr) as Record<string, unknown>;
        } catch {
          continue;
        }

        const type = String(event.event || parsed.type || "");
        if (codex && (type === "error" || type === "response.failed")) {
          throw new Error(responsesErrorMessage(parsed, type));
        }
        if (codex && type === "response.incomplete") {
          const details = (parsed.response as { incomplete_details?: { reason?: string } } | undefined)?.incomplete_details;
          if (details?.reason === "max_output_tokens") {
            terminalReceived = true;
            finishReason = "length";
            cappedByLength = true;
          } else {
            throw new Error(responsesErrorMessage(parsed, type));
          }
        }

        const usage = readResponsesUsage(parsed);
        if (usage) {
          latestUsage = usage;
          yield { type: "usage", usage: latestUsage };
        }

        if (type === "response.output_text.delta" || type === "response.reasoning_text.delta") {
          const delta = String(parsed.delta ?? "");
          if (!delta) continue;
          if (type === "response.reasoning_text.delta") {
            yield { type: "thinking_delta", delta };
          } else {
            accumulatedContent += delta;
            yield { type: "text_delta", delta };
          }
          continue;
        }

        if (type === "response.output_item.added") {
          const item = parsed.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call") {
            const index = (parsed.output_index as number | undefined) ?? itemIndex++;
            const res = accumulator.processChunk({
              index,
              id: String(item.call_id ?? item.id ?? ""),
              name: String(item.name ?? ""),
              argsDelta: typeof item.arguments === "string" ? item.arguments : undefined,
            });
            if (res.started) {
              yield { type: "tool_call_start", id: res.started.id, name: res.started.name };
            }
          }
          continue;
        }

        if (type === "response.function_call_arguments.delta") {
          const index = (parsed.output_index as number | undefined) ?? 0;
          const res = accumulator.processChunk({
            index,
            argsDelta: String(parsed.delta ?? ""),
          });
          if (res.delta) {
            yield { type: "tool_call_delta", id: res.delta.id, argsDelta: res.delta.argsDelta };
          }
          continue;
        }

        if (type === "response.completed") {
          if (codex) terminalReceived = true;
          const resp = parsed.response as Record<string, unknown> | undefined;
          const status = String(resp?.status ?? "");
          if (status === "incomplete") finishReason = "length";
        }
      }

      if (codex && !terminalReceived) throw new Error("OpenAI Responses stream ended without a terminal response event");

      const completedToolCalls = accumulator.flush();
      if (completedToolCalls.length > 0 && !cappedByLength) {
        finishReason = "tool_use";
        for (const tc of completedToolCalls) {
          yield { type: "tool_call_end", toolCall: tc };
        }
      }

      const finalAssistant: AssistantMessage = {
        role: "assistant",
        content: accumulatedContent,
        toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
      };
      yield { type: "done", reason: finishReason, message: finalAssistant };
    } catch (err: unknown) {
      const e = err as { status?: number };
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
        status: e.status,
        retryable: false,
      };
    }
  }

  private formatInput(
    messages: ConversationMessage[],
    systemPrompt?: string,
  ): { instructions?: string; input: unknown[] } {
    const input: unknown[] = [];
    let instructions = systemPrompt;

    for (const msg of messages) {
      if (msg.role === "system") {
        instructions = instructions ? `${instructions}\n${msg.content}` : msg.content;
      } else if (msg.role === "user") {
        if (typeof msg.content === "string") {
          input.push({ role: "user", content: msg.content });
        } else {
          input.push({
            role: "user",
            content: msg.content.map((p) =>
              p.type === "text"
                ? { type: "input_text", text: p.text }
                : p.type === "image"
                  ? { type: "input_image", image_url: `data:${p.mimeType};base64,${p.data}` }
                  : { type: "input_text", text: "" },
            ),
          });
        }
      } else if (msg.role === "assistant") {
        if (msg.content) {
          input.push({ role: "assistant", content: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            input.push({
              type: "function_call",
              call_id: tc.id,
              name: tc.name,
              arguments: tc.rawArgs || JSON.stringify(tc.args),
            });
          }
        }
      } else if (msg.role === "tool_result") {
        input.push({
          type: "function_call_output",
          call_id: msg.toolCallId,
          output: msg.result,
        });
      }
    }

    return { instructions, input };
  }

  private formatTools(tools?: ToolDefinition[]): Array<Record<string, unknown>> {
    if (!tools || tools.length === 0) return [];
    return tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}
