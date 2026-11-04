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
import { runGuardedProviderStream } from "../stream-guard.js";
import { logLenientStreamEnd, prematureEndError, toolCutoffError } from "../stream-end.js";
import { parseToolArguments } from "../tool-accumulator.js";
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

    let accumulatedContent = "";
    let accumulatedThinking = "";
    const pendingToolCalls: ToolCall[] = [];
    let finishReason: (Extract<StreamEvent, { type: "done" }>)["reason"] = "stop";
    let terminalFinish: string | undefined;
    let sawTerminal = false;
    let emittedDelta = false;
    let lenientArgsNeedRepair = false;
    let lenientArgsNotObject = false;

    const haltedMessage = (): AssistantMessage => ({
      role: "assistant",
      content: accumulatedContent,
      thinking: accumulatedThinking || undefined,
    });

    yield* runGuardedProviderStream({
      req,
      haltedMessage,
      httpErrorLabel: "Google Gemini API error",
      emptyBodyMessage: "Empty response body from Google Gemini endpoint",
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

        if (parsed.error && typeof parsed.error === "object") {
          const errBody = parsed.error;
          const message =
            typeof errBody.message === "string" && errBody.message
              ? errBody.message
              : "Google stream error";
          const status = typeof errBody.code === "number" ? errBody.code : undefined;
          events.push({
            type: "error",
            error: new Error(message),
            status,
            retryable: false,
          });
          return { events, stop: true };
        }

        if (parsed.usageMetadata) {
          const u = parsed.usageMetadata;
          events.push({
            type: "usage",
            usage: {
              input: u.promptTokenCount ?? 0,
              output: u.candidatesTokenCount ?? 0,
              totalTokens: u.totalTokenCount ?? 0,
              cacheReadTokens: u.cachedContentTokenCount ?? 0,
            },
          });
        }

        const candidate = parsed.candidates?.[0];
        if (!candidate) return { events };

        if (candidate.finishReason) {
          sawTerminal = true;
          terminal = true;
          terminalFinish = String(candidate.finishReason);
        }

        const parts = candidate.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part.thought) {
              accumulatedThinking += part.text || "";
              emittedDelta = true;
              events.push({ type: "thinking_delta", delta: part.text || "" });
            } else if (part.text) {
              accumulatedContent += part.text;
              emittedDelta = true;
              events.push({ type: "text_delta", delta: part.text });
            }

            if (part.functionCall) {
              const rawArgs = part.functionCall.args;
              let args: Record<string, unknown>;
              if (typeof rawArgs === "string") {
                const parsed = parseToolArguments(rawArgs);
                if (!parsed.clean) lenientArgsNeedRepair = true;
                if (!rawArgs.trim().startsWith("{")) lenientArgsNotObject = true;
                args = parsed.clean ? parsed.args : (rawArgs as unknown as Record<string, unknown>);
              } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
                args = rawArgs as Record<string, unknown>;
              } else {
                args = {};
              }
              const tc: ToolCall = {
                id: `call_${Math.random().toString(36).slice(2, 10)}`,
                name: part.functionCall.name,
                args,
              };
              pendingToolCalls.push(tc);
              emittedDelta = true;
              events.push({ type: "tool_call_start", id: tc.id, name: tc.name });
            }
          }
        }
        if (terminal) return { events: [...events, ...finishGoogle()], stop: true };
        return { events };
      },
      onComplete: () => finishGoogle(),
    });

    function finishGoogle(): StreamEvent[] {
        if (terminalFinish === "MAX_TOKENS") finishReason = "length";
        else if (terminalFinish && terminalFinish !== "STOP") finishReason = "error";
        else if (pendingToolCalls.length > 0) finishReason = "tool_use";
        else finishReason = "stop";

        const events: StreamEvent[] = [];
        if (!sawTerminal) {
          if (req.strictStreamEnd !== false) {
            events.push(prematureEndError("finishReason", !emittedDelta));
            return events;
          }
          if (lenientArgsNeedRepair || lenientArgsNotObject) return [toolCutoffError()];
          logLenientStreamEnd(req.provider);
        }

        const completedToolCalls = finishReason === "tool_use" ? pendingToolCalls : [];
        for (const tc of completedToolCalls) events.push({ type: "tool_call_end", toolCall: tc });
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
