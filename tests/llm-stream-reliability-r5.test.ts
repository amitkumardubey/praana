import { afterEach, describe, expect, it } from "bun:test";
import { BedrockDriver } from "../src/llm/drivers/bedrock.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import { OpenAIResponsesDriver } from "../src/llm/drivers/responses.js";
import { runGuardedProviderStream, streamGuardPendingTimers } from "../src/llm/stream-guard.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "../src/llm/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jwt = (id = "jwt-account") =>
  `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.sig`;

const completed = { type: "response.completed", response: { status: "completed" } };

async function collectResponses(
  provider: string,
  frames: unknown[],
  extra: Partial<StreamRequest> = {},
): Promise<StreamEvent[]> {
  globalThis.fetch = (async () => {
    const sse = frames
      .map((frame) => (typeof frame === "string" ? frame : `data: ${JSON.stringify(frame)}\n\n`))
      .join("");
    return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const request: StreamRequest = {
    provider,
    model: "gpt-5.4",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
  const auth: ResolvedAuth = provider === "openai-codex" ? { bearerToken: jwt() } : { apiKey: "synthetic-openai-key" };
  const events: StreamEvent[] = [];
  for await (const event of new OpenAIResponsesDriver().stream(request, auth)) events.push(event);
  return events;
}

interface CallSpec {
  index: number;
  id: string;
  callId: string;
  name: string;
  args: string;
  parts: string[];
}

function realisticCallFrames(calls: CallSpec[], withIndex: boolean): unknown[] {
  const frames: unknown[] = [];
  for (const call of calls) {
    frames.push({
      type: "response.output_item.added",
      ...(withIndex ? { output_index: call.index } : {}),
      item: { type: "function_call", id: call.id, call_id: call.callId, name: call.name },
    });
  }
  for (const call of calls) {
    for (const part of call.parts) {
      frames.push({
        type: "response.function_call_arguments.delta",
        ...(withIndex ? { output_index: call.index } : { item_id: call.id }),
        delta: part,
      });
    }
  }
  for (const call of calls) {
    frames.push({
      type: "response.function_call_arguments.done",
      ...(withIndex ? { output_index: call.index } : { item_id: call.id }),
      item: { type: "function_call", id: call.id, call_id: call.callId, name: call.name },
    });
  }
  for (const call of calls) {
    frames.push({
      type: "response.output_item.done",
      ...(withIndex ? { output_index: call.index } : {}),
      item: {
        type: "function_call",
        id: call.id,
        call_id: call.callId,
        name: call.name,
        arguments: call.args,
      },
    });
  }
  frames.push(completed);
  return frames;
}

const oneCall: CallSpec[] = [
  {
    index: 0,
    id: "fc-a",
    callId: "call-a",
    name: "read_file",
    args: '{"path":"a.ts"}',
    parts: ['{"path":', '"a.ts"}'],
  },
];

const twoCalls: CallSpec[] = [
  ...oneCall,
  {
    index: 1,
    id: "fc-b",
    callId: "call-b",
    name: "shell",
    args: '{"cmd":"ls"}',
    parts: ['{"cmd":', '"ls"}'],
  },
];

function expectExactToolArgs(events: StreamEvent[], calls: CallSpec[]): void {
  expect(events.some((event) => event.type === "error")).toBe(false);
  const deltas = events.filter((event) => event.type === "tool_call_delta");
  const fragments = calls.flatMap((call) => call.parts);
  expect(deltas.map((event) => (event.type === "tool_call_delta" ? event.argsDelta : ""))).toEqual(fragments);
  const done = events.at(-1);
  expect(done?.type).toBe("done");
  if (done?.type !== "done") return;
  expect(done.reason).toBe("tool_use");
  expect(done.message.toolCalls?.map((call) => call.rawArgs)).toEqual(calls.map((call) => call.args));
  expect(done.message.toolCalls?.map((call) => call.id)).toEqual(calls.map((call) => call.callId));
}

const lenient = { strictStreamEnd: false as const };

function expectStreamError(events: StreamEvent[], message: string): void {
  expect(events.some((event) => event.type === "done")).toBe(false);
  expect(events.some((event) => event.type === "tool_call_end")).toBe(false);
  const error = events.at(-1);
  expect(error?.type === "error" && error.error.message).toBe(message);
}

function encodeBedrock(payload: unknown): Uint8Array {
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

async function collectBedrock(
  steps: Array<{ payload: unknown; delayMs?: number }>,
  opts: { hang: boolean; strictStreamEnd?: boolean },
): Promise<{ events: StreamEvent[]; cancelled: boolean; ms: number }> {
  let cancelled = false;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= steps.length) {
        if (opts.hang) return new Promise(() => {});
        controller.close();
        return;
      }
      const step = steps[index];
      index += 1;
      if (step?.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (step) controller.enqueue(encodeBedrock(step.payload));
    },
    cancel() {
      cancelled = true;
    },
  });
  globalThis.fetch = (async () => new Response(stream)) as typeof fetch;
  const events: StreamEvent[] = [];
  const started = Date.now();
  const req: StreamRequest = {
    model: "m",
    provider: "amazon-bedrock",
    region: "us-east-1",
    messages: [{ role: "user", content: "hi" }],
    connectTimeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    ...(opts.strictStreamEnd === undefined ? {} : { strictStreamEnd: opts.strictStreamEnd }),
  };
  const done = (async () => {
    for await (const event of new BedrockDriver().stream(req, { bearerToken: "bearer-fixture" })) {
      events.push(event);
    }
  })();
  await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Bedrock stream hung")), 4_000)),
  ]);
  return { events, cancelled: cancelled, ms: Date.now() - started };
}

const OPENAI_FINISH =
  'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n';
const OPENAI_USAGE =
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n';
const OPENAI_DONE = "data: [DONE]\n\n";

async function collectOpenAI(
  parts: Array<{ text: string; delayMs?: number }>,
  opts: { hang: boolean; idleTimeoutMs: number },
): Promise<{ events: StreamEvent[]; cancelled: boolean; ms: number }> {
  let cancelled = false;
  let index = 0;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= parts.length) {
        if (opts.hang) return new Promise(() => {});
        controller.close();
        return;
      }
      const part = parts[index];
      index += 1;
      if (part?.delayMs) await new Promise((resolve) => setTimeout(resolve, part.delayMs));
      if (part) controller.enqueue(enc.encode(part.text));
    },
    cancel() {
      cancelled = true;
    },
  });
  globalThis.fetch = (async () => new Response(stream)) as typeof fetch;
  const events: StreamEvent[] = [];
  const started = Date.now();
  const finished = (async () => {
    for await (const event of new OpenAICompatibleDriver().stream(
      {
        model: "m",
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
        connectTimeoutMs: 0,
        idleTimeoutMs: opts.idleTimeoutMs,
      },
      { apiKey: "test-key" },
    )) events.push(event);
  })();
  await Promise.race([
    finished,
    new Promise((_, reject) => setTimeout(() => reject(new Error("OpenAI stream hung")), 4_000)),
  ]);
  return { events, cancelled, ms: Date.now() - started };
}

async function collectGoogle(body: string): Promise<StreamEvent[]> {
  globalThis.fetch = (async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const event of new GoogleDriver().stream(
    {
      model: "m",
      provider: "google",
      messages: [{ role: "user", content: "hi" }],
      connectTimeoutMs: 0,
      idleTimeoutMs: 0,
    },
    { apiKey: "test-key" },
  )) events.push(event);
  return events;
}

describe("Google finish reasons", () => {
  it("keeps tool_use when a later STOP chunk has no parts", async () => {
    Math.random = () => 0.123456789;
    const events = await collectGoogle(
      [
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.ts"}}}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
      ].join(""),
    );
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.reason).toBe("tool_use");
      expect(done.message.toolCalls?.[0]?.name).toBe("read_file");
    }
  });

  it("maps MAX_TOKENS to length and any other non-STOP reason to error", async () => {
    const max = await collectGoogle('data: {"candidates":[{"finishReason":"MAX_TOKENS"}]}\n\n');
    expect(max.at(-1)).toMatchObject({ type: "done", reason: "length" });
    for (const reason of ["SAFETY", "RECITATION", "MALFORMED_FUNCTION_CALL"]) {
      const events = await collectGoogle(`data: {"candidates":[{"finishReason":"${reason}"}]}\n\n`);
      expect(events.at(-1), reason).toMatchObject({ type: "done", reason: "error" });
    }
  });
});

describe("OpenAI usage trailer after finish_reason", () => {
  it("keeps a usage chunk that arrives 30ms after finish_reason, then [DONE]", async () => {
    const { events, cancelled, ms } = await collectOpenAI(
      [
        { text: OPENAI_FINISH },
        { text: OPENAI_USAGE, delayMs: 30 },
        { text: OPENAI_DONE },
      ],
      { hang: true, idleTimeoutMs: 60_000 },
    );
    expect(events.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", usage: { input: 3, output: 1, totalTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ]);
    const usageAt = events.findIndex((event) => event.type === "usage");
    const doneAt = events.findIndex((event) => event.type === "done");
    expect(doneAt).toBeGreaterThan(usageAt);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop", message: { content: "Hi" } });
    expect(cancelled).toBe(true);
    expect(ms).toBeLessThan(1_000);
  });

  it("keeps usage that arrives in the same read as finish_reason", async () => {
    const { events, ms } = await collectOpenAI(
      [{ text: OPENAI_FINISH + OPENAI_USAGE + OPENAI_DONE }],
      { hang: true, idleTimeoutMs: 0 },
    );
    expect(events.some((event) => event.type === "usage")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    expect(ms).toBeLessThan(1_000);
  });

  it("finishes after the trailer grace when the body stays open after finish_reason", async () => {
    const { events, cancelled, ms } = await collectOpenAI(
      [{ text: OPENAI_FINISH }],
      { hang: true, idleTimeoutMs: 0 },
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop", message: { content: "Hi" } });
    expect(cancelled).toBe(true);
    expect(ms).toBeGreaterThan(1_000);
    expect(ms).toBeLessThan(4_000);
    expect(streamGuardPendingTimers()).toBe(0);
  });
});

describe("stream guard closes a pull that is still waiting", () => {
  async function releaseAndHang(idleTimeoutMs: number): Promise<{ cancelled: boolean; ms: number; done: boolean }> {
    let cancelled = false;
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(new TextEncoder().encode("one"));
          return;
        }
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = (async () => new Response(body)) as typeof fetch;
    const events: StreamEvent[] = [];
    const started = Date.now();
    const finished = (async () => {
      for await (const event of runGuardedProviderStream({
        req: {
          model: "m",
          provider: "openai",
          messages: [{ role: "user", content: "hi" }],
          connectTimeoutMs: 0,
          idleTimeoutMs,
        },
        haltedMessage: () => ({ role: "assistant", content: "" }),
        httpErrorLabel: "err",
        emptyBodyMessage: "empty",
        request: (guard) => guard.fetch("http://127.0.0.1/v1", { method: "POST" }),
        frames: async function* (stream) {
          const reader = stream.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            reader.releaseLock();
          }
        },
        onFrame: () => ({
          events: [{ type: "text_delta", delta: "Hi" }],
          releaseIfIdle: true,
        }),
        onComplete: () => [{ type: "done", reason: "stop", message: { role: "assistant", content: "Hi" } }],
      })) events.push(event);
    })();
    await Promise.race([
      finished,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`hung with idleTimeoutMs ${idleTimeoutMs}`)), 4_000)),
    ]);
    return {
      cancelled,
      ms: Date.now() - started,
      done: events.some((event) => event.type === "done"),
    };
  }

  it.each([0, 60_000])("finishes promptly and cancels the body when idleTimeoutMs is %s", async (idleTimeoutMs) => {
    const result = await releaseAndHang(idleTimeoutMs);
    expect(result.done).toBe(true);
    expect(result.cancelled).toBe(true);
    // The trailer grace is 2s. Idle 0 must not wait forever, and a long idle must not be used up.
    expect(result.ms).toBeGreaterThan(1_000);
    expect(result.ms).toBeLessThan(4_000);
    expect(streamGuardPendingTimers()).toBe(0);
  });
});

describe("Bedrock usage after messageStop", () => {
  const prefix = [
    { payload: { messageStart: { role: "assistant" } } },
    { payload: { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hi" } } } },
    { payload: { messageStop: { stopReason: "end_turn" } } },
  ];

  it("emits usage from the metadata frame that follows messageStop, then done", async () => {
    const { events, cancelled, ms } = await collectBedrock(
      [
        ...prefix,
        {
          delayMs: 30,
          payload: { metadata: { usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } } },
        },
      ],
      { hang: true },
    );
    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toEqual([
      { type: "usage", usage: { input: 11, output: 4, totalTokens: 15 } },
    ]);
    const usageAt = events.findIndex((event) => event.type === "usage");
    const doneAt = events.findIndex((event) => event.type === "done");
    expect(doneAt).toBeGreaterThan(usageAt);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: "Hi" },
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(cancelled).toBe(true);
    expect(ms).toBeLessThan(1_000);
    expect(streamGuardPendingTimers()).toBe(0);
  });

  it("finishes a strict stream that closes after messageStop without metadata", async () => {
    const { events, ms } = await collectBedrock(prefix, { hang: false, strictStreamEnd: true });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: "Hi" },
    });
    expect(ms).toBeLessThan(1_000);
    expect(streamGuardPendingTimers()).toBe(0);
  });
});

describe("Responses failures are errors on the lenient path", () => {
  const finishedTool = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call-1", name: "read_file" },
    },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"a.ts"}' },
    { type: "response.function_call_arguments.done", output_index: 0 },
  ];

  it("does not publish a completed tool call when response.failed arrives", async () => {
    const events = await collectResponses("openai", [
      ...finishedTool,
      { type: "response.failed", response: { status: "failed", error: { message: "boom" } } },
    ], lenient);
    expectStreamError(events, "boom");
  });

  it("reports an error frame instead of a normal finish", async () => {
    const events = await collectResponses("openai", [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "error", error: { message: "Backend unavailable" } },
    ], lenient);
    expectStreamError(events, "Backend unavailable");
  });

  it.each(["failed", "cancelled"] as const)("reports response.done status %s instead of stop", async (status) => {
    const events = await collectResponses("openai", [
      ...finishedTool,
      { type: "response.done", response: { status, error: { message: "Backend unavailable" } } },
    ], lenient);
    expectStreamError(events, "Backend unavailable");
  });

  it("still accepts a lenient clean close that never sends a terminal event", async () => {
    const events = await collectResponses("openai", [
      { type: "response.output_text.delta", delta: "partial" },
    ], lenient);
    expect(events.at(-1)).toEqual({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: "partial" },
    });
  });
});

describe("Responses argument deltas that arrive before the call is announced", () => {
  it("merges delta, delta, added, done into the original JSON", async () => {
    const args = '{"path":"a.ts"}';
    const events = await collectResponses("openai", [
      { type: "response.function_call_arguments.delta", item_id: "fc-1", delta: '{"path":' },
      { type: "response.function_call_arguments.delta", item_id: "fc-1", delta: '"a.ts"}' },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "read_file" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "read_file", arguments: args },
      },
      completed,
    ]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const done = events.at(-1);
    expect(done?.type === "done" && done.message.toolCalls?.[0]?.rawArgs).toBe(args);
    expect(events.filter((event) => event.type === "tool_call_delta")).toHaveLength(1);
  });

  it("still errors when a buffered call never receives added or done", async () => {
    const events = await collectResponses("openai", [
      { type: "response.function_call_arguments.delta", item_id: "fc-kept", delta: '{"path":"a.ts"}' },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc-opened", call_id: "call-opened", name: "shell", arguments: "{}" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc-orphan", delta: '{"cmd":"ls"}' },
      completed,
    ]);
    expect(events.some((event) => event.type === "done")).toBe(false);
    const error = events.at(-1);
    expect(error?.type === "error" && error.error.message).toBe(
      "OpenAI Responses stream received function call arguments without an open call",
    );
  });
});

describe("Responses tool arguments are not repeated", () => {
  it.each([
    ["openai", true, oneCall],
    ["openai", false, oneCall],
    ["openai", true, twoCalls],
    ["openai", false, twoCalls],
    ["openai-codex", true, oneCall],
    ["openai-codex", false, oneCall],
    ["openai-codex", true, twoCalls],
    ["openai-codex", false, twoCalls],
  ] as const)("%s keeps each fragment once (output_index=%s)", async (provider, withIndex, calls) => {
    const events = await collectResponses(provider, realisticCallFrames(calls, withIndex));
    expectExactToolArgs(events, calls);
  });
});
