// ============================================================
// PRAANA — Google Gemini & Vertex AI Wire Protocol Driver
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
import { withPreEmissionRetry } from "../retry.js";
import { resolveVertexAccessToken } from "../google-adc.js";

export class GoogleDriver implements LlmDriver {
  readonly protocol = "google-generative-ai";

  async *stream(req: StreamRequest, auth: ResolvedAuth): AsyncIterable<StreamEvent> {
    const isVertex = req.provider === "vertex";
    let endpoint: string;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(req.headers || {}),
      ...(auth.headers || {}),
    };

    if (isVertex) {
      const region = process.env.VERTEX_REGION || "us-central1";
      const project = process.env.VERTEX_PROJECT_ID || process.env.GCP_PROJECT || "default";
      endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${req.model}:streamGenerateContent?alt=sse`;
      try {
        const token = await resolveVertexAccessToken({
          bearerToken: auth.bearerToken,
          apiKey: auth.apiKey,
        });
        headers.Authorization = `Bearer ${token}`;
      } catch (err) {
        yield {
          type: "error",
          error: err instanceof Error ? err : new Error(String(err)),
          status: 401,
          retryable: false,
        };
        return;
      }
    } else {
      const baseUrl = req.baseUrl || auth.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
      endpoint = `${baseUrl.replace(/\/+$/, "")}/models/${req.model}:streamGenerateContent?alt=sse`;
      if (auth.apiKey) {
        headers["x-goog-api-key"] = auth.apiKey;
      } else if (auth.bearerToken) {
        headers["x-goog-api-key"] = auth.bearerToken;
      }
    }

    const { contents, systemInstruction } = this.formatContents(req.messages, req.systemPrompt);
    const tools = this.formatTools(req.tools);

    const body: Record<string, unknown> = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      generationConfig: {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
      },
    };

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
            const err: any = new Error(`Google Gemini API error (${res.status}): ${errText}`);
            err.status = res.status;
            throw err;
          }

          if (!res.body) {
            throw new Error("Empty response body from Google Gemini endpoint");
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

    let accumulatedContent = "";
    let accumulatedThinking = "";
    const pendingToolCalls: ToolCall[] = [];
    let finishReason: (Extract<StreamEvent, { type: "done" }>)["reason"] = "stop";

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
              toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
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

        // Token usage
        if (parsed.usageMetadata) {
          const u = parsed.usageMetadata;
          yield {
            type: "usage",
            usage: {
              input: u.promptTokenCount ?? 0,
              output: u.candidatesTokenCount ?? 0,
              totalTokens: u.totalTokenCount ?? 0,
              cacheReadTokens: u.cachedContentTokenCount ?? 0,
            },
          };
        }

        const candidate = parsed.candidates?.[0];
        if (!candidate) continue;

        if (candidate.finishReason === "STOP") finishReason = "stop";
        else if (candidate.finishReason === "MAX_TOKENS") finishReason = "length";

        const parts = candidate.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part.thought) {
              accumulatedThinking += part.text || "";
              yield { type: "thinking_delta", delta: part.text || "" };
            } else if (part.text) {
              accumulatedContent += part.text;
              yield { type: "text_delta", delta: part.text };
            }

            if (part.functionCall) {
              const tc: ToolCall = {
                id: `call_${Math.random().toString(36).slice(2, 10)}`,
                name: part.functionCall.name,
                args: part.functionCall.args || {},
              };
              pendingToolCalls.push(tc);
              yield { type: "tool_call_start", id: tc.id, name: tc.name };
              yield { type: "tool_call_end", toolCall: tc };
              finishReason = "tool_use";
            }
          }
        }
      }

      const finalAssistant: AssistantMessage = {
        role: "assistant",
        content: accumulatedContent,
        thinking: accumulatedThinking || undefined,
        toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
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

  private formatContents(
    messages: ConversationMessage[],
    systemPrompt?: string,
  ): {
    systemInstruction?: { parts: Array<{ text: string }> };
    contents: Array<Record<string, unknown>>;
  } {
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;
    if (systemPrompt) {
      systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const contents: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        if (!systemInstruction) systemInstruction = { parts: [] };
        systemInstruction.parts.push({ text: msg.content });
      } else if (msg.role === "user") {
        if (typeof msg.content === "string") {
          contents.push({ role: "user", parts: [{ text: msg.content }] });
        } else {
          const parts = msg.content.map((p) => {
            if (p.type === "text") return { text: p.text };
            if (p.type === "image") {
              return {
                inlineData: { mimeType: p.mimeType, data: p.data },
              };
            }
            return { text: "" };
          });
          contents.push({ role: "user", parts });
        }
      } else if (msg.role === "assistant") {
        const parts: Array<Record<string, unknown>> = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            parts.push({ functionCall: { name: tc.name, args: tc.args } });
          }
        }
        contents.push({ role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] });
      } else if (msg.role === "tool_result") {
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: msg.toolName,
                response: { output: msg.result, isError: msg.isError },
              },
            },
          ],
        });
      }
    }

    return { systemInstruction, contents };
  }

  private formatTools(tools?: ToolDefinition[]): Array<Record<string, unknown>> {
    if (!tools || tools.length === 0) return [];
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }
}
