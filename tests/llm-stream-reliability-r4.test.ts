import { afterEach, describe, expect, it } from "bun:test";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { BedrockDriver } from "../src/llm/drivers/bedrock.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import { runGuardedProviderStream, ConnectTimeoutError } from "../src/llm/stream-guard.js";
import { withPreEmissionRetry } from "../src/llm/retry.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "../src/llm/types.js";
import { idleTimeoutUserMessage } from "../src/turn.js";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

const auth: ResolvedAuth = { apiKey: "test-key" };

function hangAfter(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
        return;
      }
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

function textChunks(parts: string[]): Uint8Array[] {
  const enc = new TextEncoder();
  return parts.map((part) => enc.encode(part));
}

async function collectHung(
  driver: { stream: (req: StreamRequest, auth: ResolvedAuth) => AsyncIterable<StreamEvent> },
  req: StreamRequest,
  chunks: Uint8Array[],
): Promise<{ events: StreamEvent[]; cancelled: boolean; ms: number }> {
  const hanging = hangAfter(chunks);
  globalThis.fetch = (async () => new Response(hanging.stream)) as typeof fetch;
  const events: StreamEvent[] = [];
  const started = Date.now();
  const done = (async () => {
    for await (const event of driver.stream(req, auth)) events.push(event);
  })();
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("stream kept reading after the terminal event")), 400);
  });
  await Promise.race([done, timeout]);
  return { events, cancelled: hanging.cancelled(), ms: Date.now() - started };
}

const budgets = { connectTimeoutMs: 60_000, idleTimeoutMs: 60_000 };

describe("terminal sentinel stops the read", () => {
  it("finishes an Anthropic tool call when message_stop is followed by silence", async () => {
    const body = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    const { events, cancelled, ms } = await collectHung(
      new AnthropicDriver(),
      { model: "m", provider: "anthropic", messages: [{ role: "user", content: "hi" }], ...budgets },
      textChunks(body),
    );
    expect(ms).toBeLessThan(400);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "tool_call_start" && event.name === "read_file")).toBe(true);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.reason).toBe("tool_use");
    expect(cancelled).toBe(true);
  });

  it("finishes an OpenAI tool call when finish_reason is followed by silence", async () => {
    const body = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { events, cancelled, ms } = await collectHung(
      new OpenAICompatibleDriver(),
      { model: "m", provider: "openai", messages: [{ role: "user", content: "hi" }], ...budgets },
      textChunks(body),
    );
    expect(ms).toBeLessThan(400);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message.toolCalls?.[0]?.name).toBe("read_file");
    }
    expect(cancelled).toBe(true);
  });

  it("finishes a Gemini answer when finishReason is followed by silence", async () => {
    const body = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
    ];
    const { events, cancelled, ms } = await collectHung(
      new GoogleDriver(),
      { model: "m", provider: "google", messages: [{ role: "user", content: "hi" }], ...budgets },
      textChunks(body),
    );
    expect(ms).toBeLessThan(400);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: "Hi" },
    });
    expect(cancelled).toBe(true);
  });

  it("finishes a Bedrock answer when messageStop is followed by silence", async () => {
    const { events, cancelled, ms } = await collectHung(
      new BedrockDriver(),
      {
        model: "m",
        provider: "amazon-bedrock",
        region: "us-east-1",
        messages: [{ role: "user", content: "hi" }],
        ...budgets,
      },
      [encodeBedrock({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hi" } } }), encodeBedrock({ messageStop: { stopReason: "end_turn" } })],
    );
    expect(ms).toBeLessThan(400);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: "Hi" },
    });
    expect(cancelled).toBe(true);
  });
});

describe("dispose cancels a body that did not finish", () => {
  it("cancels after an error frame, a throw, an early return, and a sentinel", async () => {
    const req: StreamRequest = {
      model: "m",
      provider: "openai",
      messages: [{ role: "user", content: "hi" }],
      ...budgets,
    };

    const errorBody = hangAfter(textChunks(['data: {"error":{"message":"nope"}}\n\n']));
    globalThis.fetch = (async () => new Response(errorBody.stream)) as typeof fetch;
    const errorEvents: StreamEvent[] = [];
    for await (const event of new OpenAICompatibleDriver().stream(req, auth)) errorEvents.push(event);
    expect(errorEvents.some((event) => event.type === "error")).toBe(true);
    expect(errorBody.cancelled()).toBe(true);

    const throwBody = hangAfter(textChunks(["data: hi\n\n"]));
    globalThis.fetch = (async () => new Response(throwBody.stream)) as typeof fetch;
    const thrown: StreamEvent[] = [];
    for await (const event of runGuardedProviderStream({
      req,
      haltedMessage: () => ({ role: "assistant", content: "" }),
      httpErrorLabel: "boom",
      emptyBodyMessage: "empty",
      request: (guard) => guard.fetch("http://127.0.0.1/v1", { method: "POST" }),
      frames: async function* (body) {
        const reader = body.getReader();
        await reader.read();
        throw new Error("handler blew up");
      },
      onFrame: () => ({ events: [] }),
      onComplete: () => [],
    })) {
      thrown.push(event);
    }
    expect(thrown.some((event) => event.type === "error" && event.error.message === "handler blew up")).toBe(true);
    expect(throwBody.cancelled()).toBe(true);

    const early = hangAfter(textChunks(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n']));
    globalThis.fetch = (async () => new Response(early.stream)) as typeof fetch;
    const iter = new OpenAICompatibleDriver().stream(req, auth)[Symbol.asyncIterator]();
    await iter.next();
    await iter.return?.();
    expect(early.cancelled()).toBe(true);
  });
});

describe("connect timeout retry budget", () => {
  it("fetches twice for a connect timeout and four times for another retryable status", async () => {
    globalThis.setTimeout = ((fn: TimerHandler, _ms?: number, ...args: unknown[]) =>
      originalSetTimeout(fn as () => void, 0, ...args)) as typeof setTimeout;

    let fetches = 0;
    globalThis.fetch = (async (_url, init) => {
      fetches += 1;
      const signal = (init as RequestInit | undefined)?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as typeof fetch;

    const events: StreamEvent[] = [];
    for await (const event of new OpenAICompatibleDriver().stream(
      {
        model: "m",
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
        connectTimeoutMs: 60_000,
        idleTimeoutMs: 60_000,
      },
      auth,
    )) {
      events.push(event);
    }
    expect(fetches).toBe(2);
    expect(events[0]?.type === "error" && events[0].error).toBeInstanceOf(ConnectTimeoutError);

    fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("nope", { status: 503 });
    }) as typeof fetch;
    const retried: StreamEvent[] = [];
    for await (const event of new OpenAICompatibleDriver().stream(
      {
        model: "m",
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
        connectTimeoutMs: 0,
        idleTimeoutMs: 0,
      },
      auth,
    )) {
      retried.push(event);
    }
    expect(fetches).toBe(4);
    expect(retried[0]?.type).toBe("error");
  });

  it("lets withPreEmissionRetry cap a connect timeout at one retry", async () => {
    let calls = 0;
    await expect(
      withPreEmissionRetry(
        async () => {
          calls += 1;
          throw new ConnectTimeoutError(60_000);
        },
        { maxRetriesFor: (err) => (err instanceof ConnectTimeoutError ? 1 : undefined), baseDelayMs: 0, maxDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ConnectTimeoutError);
    expect(calls).toBe(2);
  });
});

describe("idle timeout wording", () => {
  it("mentions the partial answer only when text was streamed", () => {
    expect(idleTimeoutUserMessage(5_000, false)).toBe(
      "The model stopped responding (idle timeout after 5s).",
    );
    expect(idleTimeoutUserMessage(5_000, true)).toBe(
      "The model stopped responding (idle timeout after 5s). The partial answer above was not completed.",
    );
  });
});

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
