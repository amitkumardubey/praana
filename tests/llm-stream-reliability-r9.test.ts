import { afterEach, describe, expect, it } from "bun:test";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { OpenAIResponsesDriver } from "../src/llm/drivers/responses.js";
import { parseSseStream } from "../src/llm/sse.js";
import { isDefaultHostedEndpoint, resolveStreamEndMode } from "../src/llm/stream-end.js";
import { resolveLlmStreamTimeouts } from "../src/llm/stream-guard.js";
import { createTestLogger, getAppLogger, setAppLogger, type PraanaLogger } from "../src/logger.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "../src/llm/types.js";

/**
 * A normally terminated Google stream must store function-call arguments as
 * an object. An unparseable string payload uses the repaired object or the
 * `{ _raw, _parseError }` wrapper, not the raw string.
 */

const originalFetch = globalThis.fetch;
const originalRandom = Math.random;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
});

function sse(frames: unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

async function collect(body: string): Promise<StreamEvent[]> {
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  const req: StreamRequest = {
    model: "m",
    provider: "google",
    messages: [{ role: "user", content: "hi" }],
    strictStreamEnd: true,
  };
  const auth: ResolvedAuth = { apiKey: "test-key" };
  const events: StreamEvent[] = [];
  for await (const event of new GoogleDriver().stream(req, auth)) events.push(event);
  return events;
}

describe("Google string arguments on a finished stream", () => {
  it("stores unparseable string args as an object", async () => {
    Math.random = () => 0.123456789;
    const events = await collect(sse([{
      candidates: [{
        content: {
          parts: [{ functionCall: { name: "read_file", args: "not json" } }],
        },
        finishReason: "STOP",
      }],
    }]));
    const ended = events.find((event) => event.type === "tool_call_end");
    expect(ended?.type).toBe("tool_call_end");
    if (ended?.type !== "tool_call_end") return;
    expect(typeof ended.toolCall.args).toBe("object");
    expect(ended.toolCall.args).toEqual({ _raw: "not json", _parseError: true });
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "tool_use" });
  });
});

describe("discarded SSE tail", () => {
  let previousLogger: PraanaLogger | undefined;
  const lines: string[] = [];

  afterEach(() => {
    if (previousLogger) setAppLogger(previousLogger);
    previousLogger = undefined;
    lines.length = 0;
  });

  function installLogger(): void {
    lines.length = 0;
    previousLogger = getAppLogger();
    setAppLogger(createTestLogger((line) => lines.push(line)));
  }

  async function read(chunks: string[]): Promise<string[]> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const event of parseSseStream(stream)) out.push(event.data);
    return out;
  }

  it("logs a discarded partial line once, with the byte count and not the text", async () => {
    installLogger();
    const tail = 'data: {"secret":"hunter2"';
    const data = await read([`data: {"ok":true}\n\n${tail}`]);
    expect(data).toEqual(['{"ok":true}']);
    const warnings = lines.filter((line) => line.includes("partial SSE line"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`"bytes":${Buffer.byteLength(tail)}`);
    expect(warnings.join("\n")).not.toContain("hunter2");
    expect(warnings.join("\n")).not.toContain("secret");
  });

  it("does not log when every line is terminated", async () => {
    installLogger();
    const data = await read(['data: {"ok":true}\n\n']);
    expect(data).toEqual(['{"ok":true}']);
    expect(lines.some((line) => line.includes("partial SSE line"))).toBe(false);
  });
});

async function drive(
  driver: { stream: (req: StreamRequest, auth: ResolvedAuth) => AsyncIterable<StreamEvent> },
  body: string,
  request: StreamRequest,
  auth: ResolvedAuth,
): Promise<StreamEvent[]> {
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const event of driver.stream(request, auth)) events.push(event);
  return events;
}

const chatReq = (provider: string): StreamRequest => ({
  model: "m",
  provider,
  messages: [{ role: "user", content: "hi" }],
  strictStreamEnd: true,
});

describe("Anthropic refusal usage", () => {
  it("reports token usage before the refusal error", async () => {
    const events = await drive(
      new AnthropicDriver(),
      sse([
        {
          type: "message_start",
          message: {
            usage: { input_tokens: 11, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
          },
        },
        { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 4 } },
        { type: "message_stop" },
      ]),
      chatReq("anthropic"),
      { apiKey: "test-key" },
    );
    const usageAt = events.findIndex((event) => event.type === "usage");
    const errorAt = events.findIndex((event) => event.type === "error");
    expect(usageAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBeGreaterThan(usageAt);
    expect(events[usageAt]).toEqual({
      type: "usage",
      usage: {
        input: 11,
        output: 4,
        totalTokens: 20,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
      },
    });
    expect(events[errorAt]).toMatchObject({
      type: "error",
      retryable: false,
    });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
});

describe("Responses numeric error status", () => {
  const auth: ResolvedAuth = { apiKey: "test-key" };

  async function statusOf(frame: unknown, provider = "openai"): Promise<number | undefined> {
    const events = await drive(
      new OpenAIResponsesDriver(),
      sse([frame]),
      chatReq(provider),
      provider === "openai-codex"
        ? { bearerToken: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.sig` }
        : auth,
    );
    const error = events.find((event) => event.type === "error");
    return error?.type === "error" ? error.status : undefined;
  }

  it("reads a numeric error.code as the HTTP status", async () => {
    expect(await statusOf({ type: "error", error: { code: 429, message: "slow down" } })).toBe(429);
  });

  it("reads a numeric error.status as the HTTP status", async () => {
    expect(await statusOf({ type: "error", error: { status: 503, message: "down" } })).toBe(503);
  });

  it("reads a numeric code on a failed response.completed", async () => {
    expect(await statusOf({
      type: "response.completed",
      response: { status: "failed", error: { code: 429, message: "slow down" } },
    })).toBe(429);
  });

  it("reads a numeric top-level status and a numeric response.error", async () => {
    expect(await statusOf({ type: "error", status: 503, error: { message: "down" } })).toBe(503);
    expect(await statusOf({ type: "response.failed", response: { error: 429 } })).toBe(429);
  });

  it("reads a numeric code on a Codex response.incomplete error", async () => {
    expect(await statusOf({
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        error: { code: 503, message: "nope" },
      },
    }, "openai-codex")).toBe(503);
  });
});

describe("hosted endpoint whitespace", () => {
  it("trims a base URL before the hosted and strict checks", () => {
    const url = " https://api.openai.com/v1";
    expect(isDefaultHostedEndpoint("openai", url)).toBe(true);
    expect(resolveStreamEndMode("openai", "auto", url)).toBe("strict");
    expect(resolveLlmStreamTimeouts({ provider: "openai", baseUrl: url }).connectTimeoutMs).toBe(60_000);
  });
});
