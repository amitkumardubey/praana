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
import { APP_VERSION } from "../../app-version.js";
import { extractAccountId } from "../jwt.js";

function presentToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function headerAccountId(headers: HeadersInit | Record<string, string> | undefined): string {
  if (!headers) return "";
  try {
    return new Headers(headers as HeadersInit).get("chatgpt-account-id")?.trim() ?? "";
  } catch {
    return "";
  }
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Keep earlier totals for fields this event does not report. Absent objects emit nothing. */
function usageFrom(raw: Record<string, unknown>, previous: ProviderUsage | null): ProviderUsage | null {
  const input = finiteToken(raw.input_tokens) ?? finiteToken(raw.prompt_tokens);
  const output = finiteToken(raw.output_tokens) ?? finiteToken(raw.completion_tokens);
  const totalTokens = finiteToken(raw.total_tokens);
  if (input === undefined && output === undefined && totalTokens === undefined) return null;
  return {
    input: input ?? previous?.input ?? 0,
    output: output ?? previous?.output ?? 0,
    totalTokens: totalTokens ?? previous?.totalTokens ?? 0,
  };
}

/**
 * Top-level `usage`, or `response.usage` on completed/incomplete events.
 * An empty object is ignored so it cannot replace an earlier reading.
 * When the nested object has no token counts, a top-level usage object is used.
 */
function readResponsesUsage(
  parsed: Record<string, unknown>,
  previous: ProviderUsage | null,
): ProviderUsage | null {
  const response = parsed.response;
  const nested = response && typeof response === "object"
    ? usageRecord((response as { usage?: unknown }).usage)
    : undefined;
  const top = usageRecord(parsed.usage);
  if (nested) {
    const parsedNested = usageFrom(nested, previous);
    if (parsedNested) return parsedNested;
  }
  return top ? usageFrom(top, previous) : null;
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
        // The turn loop copies the stored access token onto the request. That is
        // the stored credential, so its chatgpt-account-id header wins over the
        // JWT claim. A different token supplied by the caller is a separate
        // credential: its account id comes from that token, not from the stored header.
        const requestToken = presentToken(req.bearerToken) ?? presentToken(req.apiKey);
        const authBearer = presentToken(auth.bearerToken);
        const authKey = presentToken(auth.apiKey);
        const callerOverride = requestToken !== undefined && (
          (authBearer !== undefined && requestToken !== authBearer) ||
          (authBearer === undefined && authKey !== undefined && requestToken !== authKey)
        );
        const token = callerOverride ? requestToken : (authBearer ?? authKey ?? requestToken);
        if (!token) throw new Error("OpenAI Codex requires an access token and account id; run /login openai-codex again");
        const accountId = callerOverride
          ? extractAccountId(token)
          : headerAccountId(auth.headers) || headerAccountId(req.headers) || extractAccountId(token);
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
      ...(req.provider !== "openai-codex" && req.temperature !== undefined ? { temperature: req.temperature } : {}),
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
    const openFunctionCalls = new Set<number | string>();
    const functionCallIndexById = new Map<string, number | string>();
    const toolCutoffMessage = "The response was cut off while the model was calling a tool";
    const unannouncedToolDeltaMessage = "OpenAI Responses stream received function call arguments without an open call";
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
        if (!dataStr) continue;
        if (dataStr === "[DONE]") {
          if (codex) terminalReceived = true;
          continue;
        }
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
        const applyCodexIncomplete = (): "cutoff" | "length" | "error" => {
          const details = (parsed.response as { incomplete_details?: { reason?: string } } | undefined)?.incomplete_details;
          if (details?.reason !== "max_output_tokens") return "error";
          terminalReceived = true;
          if (openFunctionCalls.size > 0) return "cutoff";
          finishReason = "length";
          return "length";
        };
        let toolCutoff = false;
        if (codex && type === "response.incomplete") {
          const outcome = applyCodexIncomplete();
          if (outcome === "cutoff") toolCutoff = true;
          else if (outcome === "error") throw new Error(responsesErrorMessage(parsed, type));
        }

        const usage = readResponsesUsage(parsed, latestUsage);
        if (usage) {
          latestUsage = usage;
          yield { type: "usage", usage: latestUsage };
        }
        if (toolCutoff) {
          yield {
            type: "error",
            error: new Error(toolCutoffMessage),
            retryable: false,
          };
          return;
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
              openFunctionCalls.add(index);
              if (typeof item.call_id === "string" && item.call_id) functionCallIndexById.set(item.call_id, index);
              if (typeof item.id === "string" && item.id) functionCallIndexById.set(item.id, index);
              yield { type: "tool_call_start", id: res.started.id, name: res.started.name };
            }
          }
          continue;
        }

        if (type === "response.function_call_arguments.done" || type === "response.output_item.done") {
          const item = parsed.item as { type?: string; id?: string; call_id?: string } | undefined;
          if (type === "response.function_call_arguments.done" || item?.type === "function_call") {
            const explicit = parsed.output_index;
            if (typeof explicit === "number") {
              openFunctionCalls.delete(explicit);
            } else {
              const itemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
              const keys = [itemId, item?.id, item?.call_id];
              for (const key of keys) {
                if (!key) continue;
                const index = functionCallIndexById.get(key);
                if (index !== undefined) {
                  openFunctionCalls.delete(index);
                  break;
                }
              }
            }
          }
        }

        if (type === "response.function_call_arguments.delta") {
          const explicit = parsed.output_index;
          const itemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
          const index = typeof explicit === "number"
            ? explicit
            : itemId !== undefined
              ? functionCallIndexById.get(itemId)
              : undefined;
          // A delta may only extend a call output_item.added already opened.
          if (index === undefined || !openFunctionCalls.has(index)) {
            yield {
              type: "error",
              error: new Error(unannouncedToolDeltaMessage),
              retryable: false,
            };
            return;
          }
          const argsDelta = typeof parsed.delta === "string" ? parsed.delta : "";
          if (argsDelta === "") continue;
          const res = accumulator.processChunk({ index, argsDelta });
          if (res.delta) {
            yield { type: "tool_call_delta", id: res.delta.id, argsDelta: res.delta.argsDelta };
          }
          continue;
        }

        if (codex && type === "response.done") {
          const resp = parsed.response as Record<string, unknown> | undefined;
          const status = typeof resp?.status === "string" ? resp.status : "";
          if (status === "failed" || status === "cancelled" || parsed.error != null || resp?.error != null) {
            throw new Error(responsesErrorMessage(parsed, type));
          }
          terminalReceived = true;
          if (status === "incomplete") {
            const outcome = applyCodexIncomplete();
            if (outcome === "error") throw new Error(responsesErrorMessage(parsed, type));
            if (outcome === "cutoff") {
              yield { type: "error", error: new Error(toolCutoffMessage), retryable: false };
              return;
            }
          }
        } else if (type === "response.completed") {
          const resp = parsed.response as Record<string, unknown> | undefined;
          const status = String(resp?.status ?? "");
          if (codex) {
            terminalReceived = true;
            if (status === "incomplete") {
              const outcome = applyCodexIncomplete();
              if (outcome === "error") throw new Error(responsesErrorMessage(parsed, type));
              if (outcome === "cutoff") {
                yield { type: "error", error: new Error(toolCutoffMessage), retryable: false };
                return;
              }
            }
          } else if (status === "incomplete") {
            finishReason = "length";
          }
        }
      }

      if (codex && !terminalReceived) throw new Error("OpenAI Responses stream ended without a terminal response event");

      const completedToolCalls = accumulator.flush();
      const publishToolCalls = completedToolCalls.length > 0;
      if (publishToolCalls) {
        finishReason = "tool_use";
        for (const tc of completedToolCalls) {
          yield { type: "tool_call_end", toolCall: tc };
        }
      }

      const finalAssistant: AssistantMessage = {
        role: "assistant",
        content: accumulatedContent,
        toolCalls: publishToolCalls ? completedToolCalls : undefined,
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
