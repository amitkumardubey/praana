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
import { signAwsRequest, parseAwsEventStream } from "../aws-sigv4.js";
import { ToolCallAccumulator } from "../tool-accumulator.js";
import { withPreEmissionRetry } from "../retry.js";

export class BedrockDriver implements LlmDriver {
  readonly protocol = "bedrock-converse-stream";

  async *stream(req: StreamRequest, auth: ResolvedAuth): AsyncIterable<StreamEvent> {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
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

    // If a Bedrock bearer token is provided, use Bearer auth
    if (auth.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK) {
      headers.Authorization = `Bearer ${auth.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK}`;
    } else {
      // Sign with AWS SigV4 credentials from environment
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID || "";
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "";
      const sessionToken = process.env.AWS_SESSION_TOKEN;

      if (accessKeyId && secretAccessKey) {
        headers = signAwsRequest({
          method: "POST",
          url: endpoint,
          headers,
          body: bodyStr,
          credentials: {
            accessKeyId,
            secretAccessKey,
            sessionToken,
            region,
            service: "bedrock",
          },
        });
      }
    }

    let response: Response;
    try {
      response = await withPreEmissionRetry(
        async () => {
          const res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: bodyStr,
            signal: req.signal,
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            const err: any = new Error(`AWS Bedrock API error (${res.status}): ${errText}`);
            err.status = res.status;
            throw err;
          }

          if (!res.body) {
            throw new Error("Empty response body from AWS Bedrock endpoint");
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

    try {
      for await (const frame of parseAwsEventStream(response.body!)) {
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

        // 1. Text delta
        if (frame.contentBlockDelta) {
          const deltaObj = frame.contentBlockDelta as any;
          const delta = deltaObj.delta;
          const index = deltaObj.contentBlockIndex ?? 0;

          if (delta?.text) {
            accumulatedContent += delta.text;
            yield { type: "text_delta", delta: delta.text };
          }
          if (delta?.reasoningContent?.text) {
            accumulatedThinking += delta.reasoningContent.text;
            yield { type: "thinking_delta", delta: delta.reasoningContent.text };
          }
          if (delta?.toolUse) {
            const res = accumulator.processChunk({
              index,
              argsDelta: delta.toolUse.input,
            });
            if (res.delta) {
              yield { type: "tool_call_delta", id: res.delta.id, argsDelta: res.delta.argsDelta };
            }
          }
        }

        // 2. Tool block start
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
              yield { type: "tool_call_start", id: res.started.id, name: res.started.name };
            }
          }
        }

        // 3. Metadata / Usage
        if (frame.metadata) {
          const meta = frame.metadata as any;
          if (meta.usage) {
            yield {
              type: "usage",
              usage: {
                input: meta.usage.inputTokens ?? 0,
                output: meta.usage.outputTokens ?? 0,
                totalTokens: meta.usage.totalTokens ?? 0,
              },
            };
          }
        }

        // 4. Message stop
        if (frame.messageStop) {
          const stop = frame.messageStop as any;
          if (stop.stopReason === "tool_use") finishReason = "tool_use";
          else if (stop.stopReason === "max_tokens") finishReason = "length";
          else finishReason = "stop";
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
