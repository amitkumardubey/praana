import { afterEach, expect, test } from "bun:test";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { BedrockDriver } from "../src/llm/drivers/bedrock.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import { OpenAIResponsesDriver } from "../src/llm/drivers/responses.js";
import type { LlmDriver } from "../src/llm/drivers/base.js";
import type { AssistantMessage, StreamEvent, StreamRequest } from "../src/llm/types.js";
import { googleSse, THOUGHT_SIGNATURE } from "./helpers/google-thought-signature.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function terminal(provider: string) {
  if (provider === "amazon-bedrock") {
    const payload = Buffer.from(JSON.stringify({ messageStop: { stopReason: "end_turn" } }));
    const frame = Buffer.alloc(payload.length + 16);
    frame.writeUInt32BE(frame.length, 0);
    payload.copy(frame, 12);
    return new Response(new Uint8Array(frame));
  }
  if (provider === "google") {
    return googleSse([{ text: "done" }]);
  }
  let frames: unknown[];
  if (provider === "anthropic") {
    frames = [{ type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }];
  } else if (provider === "responses") {
    frames = [{ type: "response.completed", response: { status: "completed", output: [] } }];
  } else {
    frames = [{ choices: [{ delta: {}, finish_reason: "stop" }] }];
  }
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));
}
async function capture(driver: LlmDriver, request: StreamRequest) {
  let body: any;
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return terminal(request.provider);
  }) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const event of driver.stream(request, { apiKey: "fake-key", bearerToken: "fake-token" })) events.push(event);
  expect(events.filter(event => event.type === "error")).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
  return body;
}

for (const [provider, driver] of [
  ["openai", new OpenAICompatibleDriver()],
  ["anthropic", new AnthropicDriver()],
  ["amazon-bedrock", new BedrockDriver()],
  ["responses", new OpenAIResponsesDriver()],
] as const) {
  test(`signed Google history round-trips without leaking metadata to ${provider}`, async () => {
    const assistant: AssistantMessage = { role: "assistant", content: "reading", toolCalls: [
      { id: "a", name: "read_file", args: { path: "a.txt" }, thoughtSignature: THOUGHT_SIGNATURE },
    ] };
    const before = structuredClone(assistant);
    const request: StreamRequest = { provider, model: "test-model", messages: [
      { role: "user", content: "read a.txt" }, assistant,
      { role: "tool_result", toolCallId: "a", toolName: "read_file", result: "file contents" },
    ] };
    // Exercise both Anthropic projection branches, not only legacy convenience fields.
    for (const ordered of provider === "anthropic" ? [false, true] : [false]) {
      if (ordered) assistant.blocks = [{ type: "text", text: "reading" }, { type: "tool_use", id: "a" }];
      const body = await capture(driver, request);
      expect(JSON.stringify(body)).not.toContain("thoughtSignature");
      expect(JSON.stringify(body)).not.toContain(THOUGHT_SIGNATURE);
      expect(JSON.stringify(body)).toContain("read_file");
    }
    delete assistant.blocks;
    expect(assistant).toEqual(before);
    // Returning the same signed history to Google must still echo its signature.
    const googleBody = await capture(new GoogleDriver(), { ...request, provider: "google" });
    expect(googleBody.contents[1].parts[1]).toEqual({
      functionCall: { name: "read_file", args: { path: "a.txt" } }, thoughtSignature: THOUGHT_SIGNATURE,
    });
  });
}
