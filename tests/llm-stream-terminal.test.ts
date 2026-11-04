import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AzureDriver } from "../src/llm/drivers/azure.js";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { BedrockDriver } from "../src/llm/drivers/bedrock.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import type { LlmDriver } from "../src/llm/drivers/base.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "../src/llm/types.js";
import { createTestLogger, getAppLogger, setAppLogger, type PraanaLogger } from "../src/logger.js";

const originalFetch = globalThis.fetch;
const originalRandom = Math.random;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
});

function normalize(ev: StreamEvent): unknown {
  if (ev.type === "error") {
    return { type: "error", message: ev.error.message, retryable: ev.retryable };
  }
  return JSON.parse(JSON.stringify(ev));
}

async function collect(
  driver: LlmDriver,
  body: BodyInit,
  req: StreamRequest,
  auth: ResolvedAuth,
  opts?: { abortOnText?: boolean; abortOnToolDelta?: boolean },
): Promise<unknown[]> {
  const ac = new AbortController();
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  const events: unknown[] = [];
  const streamReq = opts?.abortOnText || opts?.abortOnToolDelta ? { ...req, signal: ac.signal } : req;
  for await (const ev of driver.stream(streamReq, auth)) {
    events.push(normalize(ev));
    if (opts?.abortOnText && ev.type === "text_delta") ac.abort();
    if (opts?.abortOnToolDelta && ev.type === "tool_call_delta") ac.abort();
  }
  return events;
}

function expectPrematureEnd(
  events: unknown[],
  opts: { signal: string; retryable: boolean; text?: string },
): void {
  const deltas = events.filter(
    (ev): ev is { type: "text_delta"; delta: string } =>
      typeof ev === "object" && ev !== null && (ev as { type?: string }).type === "text_delta",
  );
  if (opts.text === undefined) {
    expect(deltas).toEqual([]);
  } else {
    expect(deltas.map((ev) => ev.delta).join("")).toBe(opts.text);
  }
  expect(events.some((ev) => (ev as { type?: string }).type === "done")).toBe(false);
  const errors = events.filter((ev) => (ev as { type?: string }).type === "error");
  expect(errors).toEqual([
    {
      type: "error",
      message: `stream ended before the provider sent a final event (${opts.signal})`,
      retryable: opts.retryable,
    },
  ]);
}

function encodeFrame(payload: unknown): Buffer {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const totalLength = payloadBytes.length + 16;
  const buf = Buffer.alloc(totalLength);
  buf.writeUInt32BE(totalLength, 0);
  buf.writeUInt32BE(0, 4);
  buf.writeUInt32BE(0, 8);
  payloadBytes.copy(buf, 12);
  buf.writeUInt32BE(0, totalLength - 4);
  return buf;
}

function bedrockBody(payloads: unknown[]): Uint8Array {
  return Buffer.concat(payloads.map(encodeFrame));
}

const user = (provider: string): StreamRequest => ({
  model: "m",
  provider,
  messages: [{ role: "user", content: "hi" }],
});

const keyAuth: ResolvedAuth = { apiKey: "test-key" };
const bearerAuth: ResolvedAuth = { bearerToken: "bearer-fixture" };

describe("terminal stream events", () => {
  for (const [terminal, reason] of [["length", "length"], ["content_filter", "error"], ["unexpected", "error"]] as const) {
    it(`does not publish OpenAI partial tool calls on ${terminal}`, async () => {
      const body = [
        { choices: [{ delta: { content: "Partial" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a' } }] } }] },
        { choices: [{ delta: {}, finish_reason: terminal }] },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
      const events = await collect(new OpenAICompatibleDriver(), body, user("openai"), keyAuth);
      expect(events).toContainEqual({ type: "text_delta", delta: "Partial" });
      expect(events.some((ev) => (ev as { type: string }).type === "tool_call_end")).toBe(false);
      expect(events.at(-1)).toEqual({ type: "done", reason, message: { role: "assistant", content: "Partial" } });
    });
  }
  it("drops OpenAI partial tool calls on user abort", async () => {
    const body = [
      { choices: [{ delta: { content: "Partial" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    const events = await collect(new OpenAICompatibleDriver(), body, user("openai"), keyAuth, { abortOnToolDelta: true });
    expect(events.some((ev) => (ev as { type: string }).type === "tool_call_end")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", reason: "abort", message: { role: "assistant", content: "Partial", toolCalls: [] } });
  });
  for (const terminal of ["tool_calls", "function_call", "stop"]) {
    it(`keeps OpenAI tool calls on normal ${terminal}`, async () => {
      const body = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: terminal }] },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
      const events = await collect(new OpenAICompatibleDriver(), body, user("openai"), keyAuth);
      expect(events).toContainEqual({ type: "tool_call_end", toolCall: { id: "call_1", name: "read_file", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' } });
      expect(events.at(-1)).toMatchObject({ type: "done", reason: "tool_use" });
    });
  }
  it("snapshots a normal Anthropic text stream", async () => {
    const body = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":1,"cache_creation_input_tokens":2}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ].join("");
    const events = await collect(new AnthropicDriver(), body, user("anthropic"), keyAuth);
    expect(events).toEqual([
      { type: "text_delta", delta: "Hi" },
      {
        type: "usage",
        usage: { input: 5, output: 1, totalTokens: 9, cacheReadTokens: 1, cacheWriteTokens: 2 },
      },
      { type: "done", reason: "stop", message: { role: "assistant", content: "Hi" } },
    ]);
  });

  it("snapshots a normal Anthropic tool-call stream", async () => {
    const body = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ].join("");
    const events = await collect(new AnthropicDriver(), body, user("anthropic"), keyAuth);
    expect(events).toEqual([
      { type: "tool_call_start", id: "toolu_1", name: "read_file" },
      { type: "tool_call_delta", id: "toolu_1", argsDelta: '{"path":"a.ts"}' },
      {
        type: "usage",
        usage: { input: 3, output: 4, totalTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { type: "done", reason: "tool_use", message: { role: "assistant", content: "" } },
    ]);
  });

  it("treats Anthropic message_delta stop_reason as terminal without message_stop", async () => {
    const body = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ].join("");
    const events = await collect(new AnthropicDriver(), body, user("anthropic"), keyAuth);
    expect(events.at(-1)).toEqual({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: "Hi" },
    });
  });

  it("treats Anthropic message_stop as terminal without stop_reason", async () => {
    const body = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ].join("");
    const events = await collect(new AnthropicDriver(), body, user("anthropic"), keyAuth);
    expect(events.at(-1)).toEqual({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: "Hi" },
    });
  });

  it("errors when an Anthropic stream ends after text without a terminal event", async () => {
    const body =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial"}}\n\n';
    const events = await collect(new AnthropicDriver(), body, user("anthropic"), keyAuth);
    expectPrematureEnd(events, { signal: "message_stop", retryable: false, text: "Partial" });
  });

  it("errors retryably when an Anthropic stream ends before any delta", async () => {
    const body = 'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n';
    const events = await collect(new AnthropicDriver(), body, user("anthropic"), keyAuth);
    expectPrematureEnd(events, { signal: "message_stop", retryable: true });
  });

  it("yields abort when the user aborts an Anthropic stream", async () => {
    const body = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ].join("");
    const events = await collect(new AnthropicDriver(), body, user("anthropic"), keyAuth, {
      abortOnText: true,
    });
    expect(events).toEqual([
      { type: "text_delta", delta: "Hi" },
      {
        type: "done",
        reason: "abort",
        message: { role: "assistant", content: "Hi", toolCalls: [] },
      },
    ]);
  });

  it("snapshots a normal OpenAI text stream", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":4},"prompt_cache_miss_tokens":6}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const events = await collect(new OpenAICompatibleDriver(), body, user("openai"), keyAuth);
    expect(events).toEqual([
      { type: "text_delta", delta: "Hello" },
      {
        type: "usage",
        usage: { input: 10, output: 2, totalTokens: 12, cacheReadTokens: 4, cacheWriteTokens: 6 },
      },
      { type: "done", reason: "stop", message: { role: "assistant", content: "Hello" } },
    ]);
  });

  it("snapshots a normal OpenAI tool-call stream", async () => {
    const body = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const events = await collect(new OpenAICompatibleDriver(), body, user("openai"), keyAuth);
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", id: "call_1", argsDelta: '{"path":"a.ts"}' },
      {
        type: "tool_call_end",
        toolCall: {
          id: "call_1",
          name: "read_file",
          args: { path: "a.ts" },
          rawArgs: '{"path":"a.ts"}',
        },
      },
      {
        type: "done",
        reason: "tool_use",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "read_file",
              args: { path: "a.ts" },
              rawArgs: '{"path":"a.ts"}',
            },
          ],
        },
      },
    ]);
  });

  it("treats OpenAI [DONE] as terminal when finish_reason is absent", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
    const events = await collect(new OpenAICompatibleDriver(), body, user("openai"), keyAuth);
    expect(events.at(-1)).toEqual({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: "Hi" },
    });
  });

  it("treats OpenAI finish_reason as terminal when [DONE] is absent", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n';
    const events = await collect(new OpenAICompatibleDriver(), body, user("openai"), keyAuth);
    expect(events.at(-1)).toEqual({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: "Hi" },
    });
  });

  it("keeps a usage chunk after finish_reason inside a normal OpenAI completion", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const events = await collect(new OpenAICompatibleDriver(), body, user("openai"), keyAuth);
    expect(events.map((ev) => (ev as { type: string }).type)).toEqual([
      "text_delta",
      "usage",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
  });

  it("errors when an OpenAI stream ends after text without finish_reason or [DONE]", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\n';
    const events = await collect(new OpenAICompatibleDriver(), body, user("openai"), keyAuth);
    expectPrematureEnd(events, {
      signal: "finish_reason or [DONE]",
      retryable: false,
      text: "Partial",
    });
  });

  it("errors retryably when an OpenAI stream ends before any delta", async () => {
    const body = 'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n';
    const events = await collect(new OpenAICompatibleDriver(), body, user("openai"), keyAuth);
    expectPrematureEnd(events, { signal: "finish_reason or [DONE]", retryable: true });
  });

  it("yields abort when the user aborts an OpenAI stream", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n';
    const events = await collect(new OpenAICompatibleDriver(), body, user("openai"), keyAuth, {
      abortOnText: true,
    });
    expect(events).toEqual([
      { type: "text_delta", delta: "Hello" },
      {
        type: "done",
        reason: "abort",
        message: { role: "assistant", content: "Hello", toolCalls: [] },
      },
    ]);
  });

  it("snapshots a normal Google text stream", async () => {
    const body = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4,"cachedContentTokenCount":2}}\n\n',
    ].join("");
    const events = await collect(new GoogleDriver(), body, user("google"), keyAuth);
    expect(events).toEqual([
      { type: "text_delta", delta: "Hello" },
      {
        type: "usage",
        usage: { input: 3, output: 1, totalTokens: 4, cacheReadTokens: 2 },
      },
      { type: "done", reason: "stop", message: { role: "assistant", content: "Hello" } },
    ]);
  });

  it("snapshots a normal Google tool-call stream", async () => {
    Math.random = () => 0.123456789;
    const id = `call_${(0.123456789).toString(36).slice(2, 10)}`;
    const body =
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.ts"}}}]},"finishReason":"STOP"}]}\n\n';
    const events = await collect(new GoogleDriver(), body, user("google"), keyAuth);
    expect(events).toEqual([
      { type: "tool_call_start", id, name: "read_file" },
      { type: "tool_call_end", toolCall: { id, name: "read_file", args: { path: "a.ts" } } },
      {
        type: "done",
        reason: "tool_use",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id, name: "read_file", args: { path: "a.ts" } }],
        },
      },
    ]);
  });

  it("errors when a Google stream ends after text without finishReason", async () => {
    const body = 'data: {"candidates":[{"content":{"parts":[{"text":"Partial"}]}}]}\n\n';
    const events = await collect(new GoogleDriver(), body, user("google"), keyAuth);
    expectPrematureEnd(events, { signal: "finishReason", retryable: false, text: "Partial" });
  });

  it("errors retryably when a Google stream ends before any delta", async () => {
    const body =
      'data: {"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":0,"totalTokenCount":1}}\n\n';
    const events = await collect(new GoogleDriver(), body, user("google"), keyAuth);
    expectPrematureEnd(events, { signal: "finishReason", retryable: true });
  });

  it("yields abort when the user aborts a Google stream", async () => {
    const body = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
    ].join("");
    const events = await collect(new GoogleDriver(), body, user("google"), keyAuth, {
      abortOnText: true,
    });
    expect(events).toEqual([
      { type: "text_delta", delta: "Hello" },
      { type: "done", reason: "abort", message: { role: "assistant", content: "Hello" } },
    ]);
  });

  it("snapshots a normal Bedrock text stream", async () => {
    const body = bedrockBody([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
      { metadata: { usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    const events = await collect(
      new BedrockDriver(),
      body,
      user("amazon-bedrock"),
      bearerAuth,
    );
    expect(events).toEqual([
      { type: "text_delta", delta: "Hello" },
      { type: "usage", usage: { input: 2, output: 1, totalTokens: 3 } },
      { type: "done", reason: "stop", message: { role: "assistant", content: "Hello" } },
    ]);
  });

  it("snapshots a normal Bedrock tool-call stream", async () => {
    const body = bedrockBody([
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "toolu_1", name: "read_file" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{"path":"a.ts"}' } },
        },
      },
      { messageStop: { stopReason: "tool_use" } },
    ]);
    const events = await collect(
      new BedrockDriver(),
      body,
      { ...user("amazon-bedrock"), region: "us-east-1" },
      bearerAuth,
    );
    expect(events).toEqual([
      { type: "tool_call_start", id: "toolu_1", name: "read_file" },
      { type: "tool_call_delta", id: "toolu_1", argsDelta: '{"path":"a.ts"}' },
      {
        type: "tool_call_end",
        toolCall: {
          id: "toolu_1",
          name: "read_file",
          args: { path: "a.ts" },
          rawArgs: '{"path":"a.ts"}',
        },
      },
      {
        type: "done",
        reason: "tool_use",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "toolu_1",
              name: "read_file",
              args: { path: "a.ts" },
              rawArgs: '{"path":"a.ts"}',
            },
          ],
        },
      },
    ]);
  });

  it("errors when a Bedrock stream ends after text without messageStop", async () => {
    const body = bedrockBody([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Partial" } } },
    ]);
    const events = await collect(
      new BedrockDriver(),
      body,
      { ...user("amazon-bedrock"), region: "us-east-1" },
      bearerAuth,
    );
    expectPrematureEnd(events, { signal: "messageStop", retryable: false, text: "Partial" });
  });

  it("errors retryably when a Bedrock stream ends before any delta", async () => {
    const body = bedrockBody([
      { metadata: { usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } } },
    ]);
    const events = await collect(
      new BedrockDriver(),
      body,
      { ...user("amazon-bedrock"), region: "us-east-1" },
      bearerAuth,
    );
    expectPrematureEnd(events, { signal: "messageStop", retryable: true });
  });

  it("yields abort when the user aborts a Bedrock stream", async () => {
    const body = bedrockBody([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    const events = await collect(
      new BedrockDriver(),
      body,
      { ...user("amazon-bedrock"), region: "us-east-1" },
      bearerAuth,
      { abortOnText: true },
    );
    expect(events).toEqual([
      { type: "text_delta", delta: "Hello" },
      {
        type: "done",
        reason: "abort",
        message: { role: "assistant", content: "Hello", toolCalls: [] },
      },
    ]);
  });
});

const LENIENT_LOG = "stream ended without a final event; accepted (lenient)";

function loggedLenient(lines: string[], provider: string): boolean {
  return lines.some((line) => line.includes(provider) && line.includes(LENIENT_LOG));
}

function expectLenientDone(
  events: unknown[],
  opts: { text: string; reason: string; message: Record<string, unknown> },
): void {
  expect(events.filter((ev) => (ev as { type?: string }).type === "error")).toEqual([]);
  const text = events
    .filter(
      (ev): ev is { type: "text_delta"; delta: string } =>
        typeof ev === "object" && ev !== null && (ev as { type?: string }).type === "text_delta",
    )
    .map((ev) => ev.delta)
    .join("");
  expect(text).toBe(opts.text);
  const dones = events.filter((ev) => (ev as { type?: string }).type === "done");
  expect(dones).toEqual([
    { type: "done", reason: opts.reason, message: opts.message },
  ]);
}

describe("configurable stream-end strictness", () => {
  let lines: string[] = [];
  let previousLogger: PraanaLogger;

  beforeEach(() => {
    lines = [];
    previousLogger = getAppLogger();
    setAppLogger(createTestLogger((line) => lines.push(line), { debug: true }));
  });

  afterEach(() => {
    setAppLogger(previousLogger);
  });

  const anthropicPartial =
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial"}}\n\n';
  const openaiPartial =
    'data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\n';
  const googlePartial = 'data: {"candidates":[{"content":{"parts":[{"text":"Partial"}]}}]}\n\n';
  const bedrockPartial = bedrockBody([
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Partial" } } },
  ]);

  it("strict Anthropic still errors when message_stop is missing", async () => {
    const events = await collect(
      new AnthropicDriver(),
      anthropicPartial,
      { ...user("anthropic"), strictStreamEnd: true },
      keyAuth,
    );
    expectPrematureEnd(events, { signal: "message_stop", retryable: false, text: "Partial" });
    expect(loggedLenient(lines, "anthropic")).toBe(false);
  });

  it("lenient Anthropic accepts a clean close without message_stop", async () => {
    const events = await collect(
      new AnthropicDriver(),
      anthropicPartial,
      { ...user("anthropic"), strictStreamEnd: false },
      keyAuth,
    );
    expectLenientDone(events, {
      text: "Partial",
      reason: "stop",
      message: { role: "assistant", content: "Partial" },
    });
    expect(loggedLenient(lines, "anthropic")).toBe(true);
  });

  it("strict OpenAI still errors when finish_reason and [DONE] are missing", async () => {
    const events = await collect(
      new OpenAICompatibleDriver(),
      openaiPartial,
      { ...user("openai"), strictStreamEnd: true },
      keyAuth,
    );
    expectPrematureEnd(events, {
      signal: "finish_reason or [DONE]",
      retryable: false,
      text: "Partial",
    });
    expect(loggedLenient(lines, "openai")).toBe(false);
  });

  it("lenient OpenAI accepts a clean close without finish_reason or [DONE]", async () => {
    const events = await collect(
      new OpenAICompatibleDriver(),
      openaiPartial,
      { ...user("openai"), strictStreamEnd: false },
      keyAuth,
    );
    expectLenientDone(events, {
      text: "Partial",
      reason: "stop",
      message: { role: "assistant", content: "Partial" },
    });
    expect(loggedLenient(lines, "openai")).toBe(true);
  });

  it("lenient OpenAI maps a tool-call stream without finish_reason to tool_use", async () => {
    const body = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n',
    ].join("");
    const events = await collect(
      new OpenAICompatibleDriver(),
      body,
      { ...user("openai"), strictStreamEnd: false },
      keyAuth,
    );
    expect(events.filter((ev) => (ev as { type?: string }).type === "error")).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: "done",
      reason: "tool_use",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "read_file",
            args: { path: "a.ts" },
            rawArgs: '{"path":"a.ts"}',
          },
        ],
      },
    });
    expect(loggedLenient(lines, "openai")).toBe(true);
  });

  it("lenient OpenAI does not log when [DONE] is present", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
    const events = await collect(
      new OpenAICompatibleDriver(),
      body,
      { ...user("openai"), strictStreamEnd: false },
      keyAuth,
    );
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(loggedLenient(lines, "openai")).toBe(false);
  });

  it("lenient OpenAI still reports a user abort as abort", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n';
    const events = await collect(
      new OpenAICompatibleDriver(),
      body,
      { ...user("openai"), strictStreamEnd: false },
      keyAuth,
      { abortOnText: true },
    );
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "abort" });
    expect(loggedLenient(lines, "openai")).toBe(false);
  });

  it("strict Azure still errors when finish_reason and [DONE] are missing", async () => {
    const events = await collect(
      new AzureDriver(),
      openaiPartial,
      {
        ...user("azure"),
        baseUrl: "https://example.openai.azure.com/openai/deployments/gpt-4o",
        strictStreamEnd: true,
      },
      keyAuth,
    );
    expectPrematureEnd(events, {
      signal: "finish_reason or [DONE]",
      retryable: false,
      text: "Partial",
    });
    expect(loggedLenient(lines, "azure")).toBe(false);
  });

  it("lenient Azure accepts a clean close without finish_reason or [DONE]", async () => {
    const events = await collect(
      new AzureDriver(),
      openaiPartial,
      {
        ...user("azure"),
        baseUrl: "https://example.openai.azure.com/openai/deployments/gpt-4o",
        strictStreamEnd: false,
      },
      keyAuth,
    );
    expectLenientDone(events, {
      text: "Partial",
      reason: "stop",
      message: { role: "assistant", content: "Partial" },
    });
    expect(loggedLenient(lines, "azure")).toBe(true);
  });

  it("strict Google still errors when finishReason is missing", async () => {
    const events = await collect(
      new GoogleDriver(),
      googlePartial,
      { ...user("google"), strictStreamEnd: true },
      keyAuth,
    );
    expectPrematureEnd(events, { signal: "finishReason", retryable: false, text: "Partial" });
    expect(loggedLenient(lines, "google")).toBe(false);
  });

  it("lenient Google accepts a clean close without finishReason", async () => {
    const events = await collect(
      new GoogleDriver(),
      googlePartial,
      { ...user("google"), strictStreamEnd: false },
      keyAuth,
    );
    expectLenientDone(events, {
      text: "Partial",
      reason: "stop",
      message: { role: "assistant", content: "Partial" },
    });
    expect(loggedLenient(lines, "google")).toBe(true);
  });

  it("strict Bedrock still errors when messageStop is missing", async () => {
    const events = await collect(
      new BedrockDriver(),
      bedrockPartial,
      { ...user("amazon-bedrock"), region: "us-east-1", strictStreamEnd: true },
      bearerAuth,
    );
    expectPrematureEnd(events, { signal: "messageStop", retryable: false, text: "Partial" });
    expect(loggedLenient(lines, "amazon-bedrock")).toBe(false);
  });

  it("lenient Bedrock accepts a clean close without messageStop", async () => {
    const events = await collect(
      new BedrockDriver(),
      bedrockPartial,
      { ...user("amazon-bedrock"), region: "us-east-1", strictStreamEnd: false },
      bearerAuth,
    );
    expectLenientDone(events, {
      text: "Partial",
      reason: "stop",
      message: { role: "assistant", content: "Partial" },
    });
    expect(loggedLenient(lines, "amazon-bedrock")).toBe(true);
  });
});
