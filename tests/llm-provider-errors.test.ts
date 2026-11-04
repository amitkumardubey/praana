import { afterEach, describe, expect, it } from "bun:test";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { BedrockDriver } from "../src/llm/drivers/bedrock.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import type { LlmDriver } from "../src/llm/drivers/base.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "../src/llm/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function collect(
  driver: LlmDriver,
  body: BodyInit,
  req: StreamRequest,
  auth: ResolvedAuth,
): Promise<StreamEvent[]> {
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const ev of driver.stream(req, auth)) events.push(ev);
  return events;
}

function providerError(events: StreamEvent[]): Extract<StreamEvent, { type: "error" }>[] {
  return events.filter((ev): ev is Extract<StreamEvent, { type: "error" }> => ev.type === "error");
}

function encodeFrame(payload: unknown, headers?: Buffer): Buffer {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const headerBytes = headers ?? Buffer.alloc(0);
  const totalLength = 12 + headerBytes.length + payloadBytes.length + 4;
  const buf = Buffer.alloc(totalLength);
  buf.writeUInt32BE(totalLength, 0);
  buf.writeUInt32BE(headerBytes.length, 4);
  buf.writeUInt32BE(0, 8);
  headerBytes.copy(buf, 12);
  payloadBytes.copy(buf, 12 + headerBytes.length);
  buf.writeUInt32BE(0, totalLength - 4);
  return buf;
}

function encodeStringHeader(name: string, value: string): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const valueBytes = Buffer.from(value, "utf8");
  const buf = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let offset = 0;
  buf.writeUInt8(nameBytes.length, offset);
  offset += 1;
  nameBytes.copy(buf, offset);
  offset += nameBytes.length;
  buf.writeUInt8(7, offset);
  offset += 1;
  buf.writeUInt16BE(valueBytes.length, offset);
  offset += 2;
  valueBytes.copy(buf, offset);
  return buf;
}

const hi = (provider: string): StreamRequest => ({
  model: "m",
  provider,
  messages: [{ role: "user", content: "hi" }],
});

describe("mid-stream provider errors", () => {
  it("maps an Anthropic error event to the provider message and status", async () => {
    const body = [
      "event: error\n",
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ].join("");
    const events = await collect(new AnthropicDriver(), body, hi("anthropic"), { apiKey: "test-key" });
    const errors = providerError(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.message).toBe("Overloaded");
    expect(errors[0]?.status).toBe(529);
    expect(errors.some((ev) => ev.error.message.includes("stream ended before"))).toBe(false);
  });

  it("maps an OpenAI error chunk without choices", async () => {
    const body =
      'data: {"error":{"message":"Rate limit reached","type":"rate_limit_error","code":"rate_limit_exceeded"}}\n\n';
    const events = await collect(new OpenAICompatibleDriver(), body, hi("openai"), { apiKey: "test-key" });
    const errors = providerError(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.message).toBe("Rate limit reached");
    expect(errors[0]?.status).toBe(429);
    expect(errors.some((ev) => ev.error.message.includes("stream ended before"))).toBe(false);
  });

  it("maps a Gemini error object", async () => {
    const body =
      'data: {"error":{"code":429,"message":"Resource exhausted","status":"RESOURCE_EXHAUSTED"}}\n\n';
    const events = await collect(new GoogleDriver(), body, hi("google"), { apiKey: "test-key" });
    const errors = providerError(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.message).toBe("Resource exhausted");
    expect(errors[0]?.status).toBe(429);
    expect(errors.some((ev) => ev.error.message.includes("stream ended before"))).toBe(false);
  });

  it("maps a Bedrock exception frame", async () => {
    const headers = Buffer.concat([
      encodeStringHeader(":message-type", "exception"),
      encodeStringHeader(":exception-type", "throttlingException"),
    ]);
    const body = encodeFrame({ message: "Too many requests" }, headers);
    const events = await collect(
      new BedrockDriver(),
      body,
      { ...hi("amazon-bedrock"), region: "us-east-1" },
      { bearerToken: "bearer-fixture" },
    );
    const errors = providerError(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.message).toBe("Too many requests");
    expect(errors[0]?.status).toBe(429);
    expect(errors.some((ev) => ev.error.message.includes("stream ended before"))).toBe(false);
  });
});
