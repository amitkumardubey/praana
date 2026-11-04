// ============================================================
// PRAANA — AWS Bedrock ConverseStream Wire Protocol Driver
// Pure HTTP + Native SigV4 + Binary EventStream Decoder
// Zero AWS SDK Dependencies
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
import { parseAwsEventStream } from "../aws-sigv4.js";
import { ToolCallAccumulator } from "../tool-accumulator.js";
import { runGuardedProviderStream } from "../stream-guard.js";
import { logLenientStreamEnd, prematureEndError } from "../stream-end.js";
import { authorizeAwsRequest } from "../aws-credentials.js";
import { resolveBedrockRegion } from "../../bedrock/region.js";

const BEDROCK_EXCEPTION_STATUS: Record<string, number> = {
  throttlingException: 429,
  serviceUnavailableException: 503,
  internalServerException: 500,
  modelStreamErrorException: 424,
  modelTimeoutException: 408,
  validationException: 400,
  accessDeniedException: 403,
  resourceNotFoundException: 404,
};

function bedrockStreamException(
  frame: Record<string, unknown>,
): { message: string; status?: number } | null {
  if (
    frame[":message-type"] === "error" ||
    typeof frame[":error-code"] === "string" ||
    typeof frame[":error-message"] === "string"
  ) {
    const code = typeof frame[":error-code"] === "string" ? frame[":error-code"] : "";
    const headerMessage = typeof frame[":error-message"] === "string" ? frame[":error-message"] : "";
    const raw = typeof frame.message === "string" ? frame.message : "";
    const detail = [headerMessage, raw].filter((value, index, all) => value && all.indexOf(value) === index).join(": ");
    const message = code && detail ? `${code}: ${detail}` : code || detail || "Bedrock stream error";
    return { message, status: code ? BEDROCK_EXCEPTION_STATUS[code] : undefined };
  }
  const headerType = typeof frame[":exception-type"] === "string" ? frame[":exception-type"] : undefined;
  if (headerType) {
    const wrapped = frame[headerType];
    const wrappedMessage =
      wrapped && typeof wrapped === "object" ? (wrapped as { message?: unknown }).message : undefined;
    const message =
      typeof wrappedMessage === "string"
        ? wrappedMessage
        : typeof frame.message === "string"
          ? frame.message
          : headerType;
    return { message, status: BEDROCK_EXCEPTION_STATUS[headerType] };
  }
  for (const [name, status] of Object.entries(BEDROCK_EXCEPTION_STATUS)) {
    const value = frame[name];
    if (!value || typeof value !== "object") continue;
    const message = (value as { message?: unknown }).message;
    return { message: typeof message === "string" ? message : name, status };
  }
  return null;
}

export class BedrockDriver implements LlmDriver {
  readonly protocol = "bedrock-converse-stream";

  async *stream(req: StreamRequest, auth: ResolvedAuth): AsyncIterable<StreamEvent> {
    const region =
      req.region ||
      resolveBedrockRegion() ||
      process.env.AWS_REGION ||
      process.env.AWS_DEFAULT_REGION ||
      "us-east-1";
    const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(req.model)}/converse-stream`;

    const { system, messages } = this.formatMessages(req.messages, req.systemPrompt);
    const toolConfig = this.formatTools(req.tools);

    const bodyObj: Record<string, unknown> = {
      messages,
      ...(system ? { system } : {}),
      ...(toolConfig ? { toolConfig } : {}),
      inferenceConfig: {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      },
    };

    const bodyStr = JSON.stringify(bodyObj);

    let headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(req.headers || {}),
      ...(auth.headers || {}),
    };

    const bearerToken =
      auth.bearerToken ||
      (auth.apiKey && !auth.awsAmbient ? auth.apiKey : undefined) ||
      process.env.AWS_BEARER_TOKEN_BEDROCK;

    try {
      headers = await authorizeAwsRequest({
        method: "POST",
        url: endpoint,
        headers,
        body: bodyStr,
        region,
        service: "bedrock",
        bearerToken,
      });
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
        status: 401,
        retryable: false,
      };
      return;
    }

    const accumulator = new ToolCallAccumulator();
    let accumulatedContent = "";
    let accumulatedThinking = "";
    let finishReason: (Extract<StreamEvent, { type: "done" }>)["reason"] = "stop";
    let sawTerminal = false;
    let emittedDelta = false;

    const haltedMessage = (): AssistantMessage => ({
      role: "assistant",
      content: accumulatedContent,
      thinking: accumulatedThinking || undefined,
      toolCalls: [],
    });

    yield* runGuardedProviderStream({
      req,
      haltedMessage,
      httpErrorLabel: "AWS Bedrock API error",
      emptyBodyMessage: "Empty response body from AWS Bedrock endpoint",
      request: (guard) =>
        guard.fetch(endpoint, {
          method: "POST",
          headers,
          body: bodyStr,
        }),
      frames: (byteStream) => parseAwsEventStream(byteStream),
      onFrame: (frame) => {
        const events: StreamEvent[] = [];
        const exception = bedrockStreamException(frame);
        if (exception) {
          events.push({
            type: "error",
            error: new Error(exception.message),
            status: exception.status,
            retryable: false,
          });
          return { events, stop: true };
        }

        if (frame.contentBlockDelta) {
          const deltaObj = frame.contentBlockDelta as any;
          const delta = deltaObj.delta;
          const index = deltaObj.contentBlockIndex ?? 0;

          if (delta?.text) {
            accumulatedContent += delta.text;
            emittedDelta = true;
            events.push({ type: "text_delta", delta: delta.text });
          }
          if (delta?.reasoningContent?.text) {
            accumulatedThinking += delta.reasoningContent.text;
            emittedDelta = true;
            events.push({ type: "thinking_delta", delta: delta.reasoningContent.text });
          }
          if (delta?.toolUse) {
            const res = accumulator.processChunk({
              index,
              argsDelta: delta.toolUse.input,
            });
            if (res.delta) {
              emittedDelta = true;
              events.push({ type: "tool_call_delta", id: res.delta.id, argsDelta: res.delta.argsDelta });
            }
          }
        }

        if (frame.contentBlockStart) {
          const startObj = frame.contentBlockStart as any;
          const start = startObj.start;
          const index = startObj.contentBlockIndex ?? 0;

          if (start?.toolUse) {
            const res = accumulator.processChunk({
              index,
              id: start.toolUse.toolUseId,
              name: start.toolUse.name,
            });
            if (res.started) {
              emittedDelta = true;
              events.push({ type: "tool_call_start", id: res.started.id, name: res.started.name });
            }
          }
        }

        if (frame.metadata) {
          const meta = frame.metadata as any;
          if (meta.usage) {
            events.push({
              type: "usage",
              usage: {
                input: meta.usage.inputTokens ?? 0,
                output: meta.usage.outputTokens ?? 0,
                totalTokens: meta.usage.totalTokens ?? 0,
              },
            });
          }
          if (sawTerminal) return { events: [...events, ...finishBedrock()], stop: true };
        }

        if (frame.messageStop) {
          sawTerminal = true;
          const stop = frame.messageStop as any;
          if (stop.stopReason === "tool_use") finishReason = "tool_use";
          else if (stop.stopReason === "max_tokens") finishReason = "length";
          else if (stop.stopReason === "end_turn" || stop.stopReason === "stop_sequence") finishReason = "stop";
          else finishReason = "error";
          // usage arrives in a later metadata event. Read until that frame,
          // the body end, or the trailer grace.
          return { events, awaitTrailer: true };
        }
        return { events };
      },
      onComplete: () => finishBedrock(),
    });

    function finishBedrock(): StreamEvent[] {
        const events: StreamEvent[] = [];
        if (!sawTerminal) {
          if (req.strictStreamEnd !== false) {
            events.push(prematureEndError("messageStop", !emittedDelta));
            return events;
          }
          logLenientStreamEnd(req.provider);
        }

        const completedToolCalls = finishReason === "tool_use" ? accumulator.flush() : [];
        if (completedToolCalls.length > 0) {
          finishReason = "tool_use";
          for (const tc of completedToolCalls) {
            events.push({ type: "tool_call_end", toolCall: tc });
          }
        }

        events.push({
          type: "done",
          reason: finishReason,
          message: {
            role: "assistant",
            content: accumulatedContent,
            thinking: accumulatedThinking || undefined,
            toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
          },
        });
        return events;
    }
  }

  private formatMessages(
    messages: ConversationMessage[],
    systemPrompt?: string,
  ): {
    system?: Array<{ text: string }>;
    messages: Array<Record<string, unknown>>;
  } {
    let system: Array<{ text: string }> | undefined;
    if (systemPrompt) {
      system = [{ text: systemPrompt }];
    }

    const formatted: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        if (!system) system = [];
        system.push({ text: msg.content });
      } else if (msg.role === "user") {
        if (typeof msg.content === "string") {
          formatted.push({ role: "user", content: [{ text: msg.content }] });
        } else {
          const parts = msg.content.map((p) => {
            if (p.type === "text") return { text: p.text };
            return { text: "" };
          });
          formatted.push({ role: "user", content: parts });
        }
      } else if (msg.role === "assistant") {
        const content: Array<Record<string, unknown>> = [];
        if (msg.content) content.push({ text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({
              toolUse: {
                toolUseId: tc.id,
                name: tc.name,
                input: tc.args,
              },
            });
          }
        }
        formatted.push({ role: "assistant", content: content.length > 0 ? content : [{ text: "" }] });
      } else if (msg.role === "tool_result") {
        formatted.push({
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: msg.toolCallId,
                content: [{ text: msg.result }],
                status: msg.isError ? "error" : "success",
              },
            },
          ],
        });
      }
    }

    return { system, messages: formatted };
  }

  private formatTools(tools?: ToolDefinition[]): Record<string, unknown> | undefined {
    if (!tools || tools.length === 0) return undefined;
    return {
      tools: tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: {
            json: t.parameters,
          },
        },
      })),
    };
  }
}
