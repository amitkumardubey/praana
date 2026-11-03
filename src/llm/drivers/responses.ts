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
import { runGuardedProviderStream } from "../stream-guard.js";
import { prematureEndError } from "../stream-end.js";
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
  const resolvedInput = input ?? previous?.input ?? 0;
  const resolvedOutput = output ?? previous?.output ?? 0;
  // When this event reports input or output but no total, the previous total
  // would be stale: recompute it from the resolved counts. Keep the previous
  // total only when neither was reported in this event.
  const resolvedTotal =
    totalTokens ??
    (input !== undefined || output !== undefined
      ? resolvedInput + resolvedOutput
      : previous?.totalTokens ?? 0);
  return {
    input: resolvedInput,
    output: resolvedOutput,
    totalTokens: resolvedTotal,
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

    const accumulator = new ToolCallAccumulator();
    let accumulatedContent = "";
    let finishReason: Extract<StreamEvent, { type: "done" }>["reason"] = "stop";
    let latestUsage: Extract<StreamEvent, { type: "usage" }>["usage"] | null = null;
    let itemIndex = 0;
    let emitted = false;
    const codex = req.provider === "openai-codex";
    let terminalReceived = false;
    const openFunctionCalls = new Set<number | string>();
    const functionCallIndexById = new Map<string, number | string>();
    const bufferedArgs = new Map<string, string>();
    // Opened calls stay "seen" after arguments.done removes them from
    // openFunctionCalls. output_item.done may repeat the full arguments
    // string; that fallback is only for a call that was never announced.
    const openedCallIndexes = new Set<number | string>();
    const openedCallIds = new Set<string>();
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
    const finish = (): StreamEvent[] => {
      if (!codex && bufferedArgs.size > 0) {
        return [{ type: "error", error: new Error(unannouncedToolDeltaMessage), retryable: false }];
      }
      if (codex && !terminalReceived) {
        return [{
          type: "error",
          error: new Error("OpenAI Responses stream ended without a terminal response event"),
          retryable: false,
          kind: "premature_end",
        }];
      }
      if (!codex && req.strictStreamEnd === true && !terminalReceived) {
        return [prematureEndError("response.completed", !emitted)];
      }
      const events: StreamEvent[] = [];
      const completedToolCalls = accumulator.flush();
      const publishToolCalls = completedToolCalls.length > 0;
      if (publishToolCalls) {
        finishReason = "tool_use";
        for (const tc of completedToolCalls) events.push({ type: "tool_call_end", toolCall: tc });
      }
      const finalAssistant: AssistantMessage = {
        role: "assistant",
        content: accumulatedContent,
        toolCalls: publishToolCalls ? completedToolCalls : undefined,
      };
      events.push({ type: "done", reason: finishReason, message: finalAssistant });
      return events;
    };

    yield* runGuardedProviderStream({
      req,
      haltedMessage: () => ({
        role: "assistant",
        content: accumulatedContent,
        toolCalls: accumulator.flush(),
      }),
      httpErrorLabel: "OpenAI Responses API error",
      emptyBodyMessage: "Empty response body from Responses endpoint",
      request: (guard) =>
        guard.fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      frames: (byteStream) => parseSseStream(byteStream),
      onFrame: (event) => {
        const events: StreamEvent[] = [];
        const fail = (message: string, status?: number): { events: StreamEvent[]; stop: true } => {
          events.push({ type: "error", error: new Error(message), status, retryable: false });
          return { events, stop: true };
        };
        const dataStr = event.data?.trim();
        if (!dataStr) return { events };
        if (dataStr === "[DONE]") {
          terminalReceived = true;
          return { events: finish(), stop: true };
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(dataStr) as Record<string, unknown>;
        } catch {
          return { events };
        }

        const type = String(event.event || parsed.type || "");
        if ((codex || req.strictStreamEnd === true) && (type === "error" || type === "response.failed")) {
          return fail(responsesErrorMessage(parsed, type));
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
          else if (outcome === "error") return fail(responsesErrorMessage(parsed, type));
        }

        const usage = readResponsesUsage(parsed, latestUsage);
        if (usage) {
          latestUsage = usage;
          events.push({ type: "usage", usage: latestUsage });
        }
        if (toolCutoff) return fail(toolCutoffMessage);

        if (type === "response.output_text.delta" || type === "response.reasoning_text.delta") {
          const delta = String(parsed.delta ?? "");
          if (delta) {
            emitted = true;
            if (type === "response.reasoning_text.delta") events.push({ type: "thinking_delta", delta });
            else {
              accumulatedContent += delta;
              events.push({ type: "text_delta", delta });
            }
          }
          return { events };
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
              emitted = true;
              openFunctionCalls.add(index);
              openedCallIndexes.add(index);
              if (typeof item.call_id === "string" && item.call_id) {
                functionCallIndexById.set(item.call_id, index);
                openedCallIds.add(item.call_id);
              }
              if (typeof item.id === "string" && item.id) {
                functionCallIndexById.set(item.id, index);
                openedCallIds.add(item.id);
              }
              events.push({ type: "tool_call_start", id: res.started.id, name: res.started.name });
            }
          }
          return { events };
        }

        if (type === "response.function_call_arguments.done" || type === "response.output_item.done") {
          const item = parsed.item as {
            type?: string;
            id?: string;
            call_id?: string;
            name?: string;
            arguments?: string;
          } | undefined;
          let matchedOpen = false;
          if (type === "response.function_call_arguments.done" || item?.type === "function_call") {
            const explicit = parsed.output_index;
            if (typeof explicit === "number" && openFunctionCalls.has(explicit)) {
              openFunctionCalls.delete(explicit);
              matchedOpen = true;
            } else {
              const itemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
              for (const key of [itemId, item?.id, item?.call_id]) {
                if (!key) continue;
                const index = functionCallIndexById.get(key);
                if (index !== undefined && openFunctionCalls.has(index)) {
                  openFunctionCalls.delete(index);
                  matchedOpen = true;
                  break;
                }
              }
            }
          }
          if (!codex && !matchedOpen && type === "response.output_item.done" && item?.type === "function_call") {
            const ids = [typeof parsed.item_id === "string" ? parsed.item_id : undefined, item.id, item.call_id]
              .filter((id): id is string => typeof id === "string" && id.length > 0);
            const explicitIndex = typeof parsed.output_index === "number" ? parsed.output_index : undefined;
            const alreadyOpened =
              (explicitIndex !== undefined && openedCallIndexes.has(explicitIndex)) ||
              ids.some((id) => openedCallIds.has(id));
            if (!alreadyOpened) {
              const buffered = ids.map((id) => bufferedArgs.get(id)).find((value) => value !== undefined) ?? "";
              for (const id of ids) bufferedArgs.delete(id);
              const args = typeof item.arguments === "string" ? item.arguments : buffered;
              const index = explicitIndex ?? itemIndex++;
              const res = accumulator.processChunk({
                index,
                id: String(item.call_id ?? item.id ?? ""),
                name: String(item.name ?? ""),
                argsDelta: args || undefined,
              });
              if (res.started) {
                emitted = true;
                openedCallIndexes.add(index);
                for (const id of ids) openedCallIds.add(id);
                events.push({ type: "tool_call_start", id: res.started.id, name: res.started.name });
              }
              if (res.delta) events.push({ type: "tool_call_delta", id: res.delta.id, argsDelta: res.delta.argsDelta });
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
          if (index === undefined || !openFunctionCalls.has(index)) {
            if (!codex && itemId) {
              const piece = typeof parsed.delta === "string" ? parsed.delta : "";
              if (piece) bufferedArgs.set(itemId, (bufferedArgs.get(itemId) ?? "") + piece);
              return { events };
            }
            return fail(unannouncedToolDeltaMessage);
          }
          const argsDelta = typeof parsed.delta === "string" ? parsed.delta : "";
          if (argsDelta === "") return { events };
          const res = accumulator.processChunk({ index, argsDelta });
          if (res.delta) {
            emitted = true;
            events.push({ type: "tool_call_delta", id: res.delta.id, argsDelta: res.delta.argsDelta });
          }
          return { events };
        }

        if (codex && type === "response.done") {
          const resp = parsed.response as Record<string, unknown> | undefined;
          const status = typeof resp?.status === "string" ? resp.status : "";
          if (status === "failed" || status === "cancelled" || parsed.error != null || resp?.error != null) {
            return fail(responsesErrorMessage(parsed, type));
          }
          terminalReceived = true;
          if (status === "incomplete") {
            const outcome = applyCodexIncomplete();
            if (outcome === "error") return fail(responsesErrorMessage(parsed, type));
            if (outcome === "cutoff") return fail(toolCutoffMessage);
          }
        } else if (type === "response.completed") {
          const resp = parsed.response as Record<string, unknown> | undefined;
          const status = String(resp?.status ?? "");
          if (codex) {
            terminalReceived = true;
            if (status === "incomplete") {
              const outcome = applyCodexIncomplete();
              if (outcome === "error") return fail(responsesErrorMessage(parsed, type));
              if (outcome === "cutoff") return fail(toolCutoffMessage);
            }
          } else if (status === "incomplete") {
            finishReason = "length";
          }
        }

        if (
          type === "response.completed" ||
          type === "response.incomplete" ||
          type === "response.done"
        ) {
          terminalReceived = true;
          return { events: [...events, ...finish()], stop: true };
        }
        return { events };
      },
      onComplete: () => finish(),
    });
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
