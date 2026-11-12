import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import { OpenAIResponsesDriver } from "../src/llm/drivers/responses.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { BedrockDriver } from "../src/llm/drivers/bedrock.js";
import { AzureDriver } from "../src/llm/drivers/azure.js";
import type { LlmDriver } from "../src/llm/drivers/base.js";
import type { AssistantMessage, StreamEvent, StreamRequest } from "../src/llm/types.js";
import { anthropicSse, signedAssistant, signedBlockFrames, signedWireBlocks } from "./helpers/anthropic-blocks.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const terminal = (stop_reason: string) => ({ type: "message_delta", delta: { stop_reason } });
const request = (): StreamRequest => ({
  provider: "anthropic", model: "claude-blocks-test", messages: [{ role: "user", content: "read the file" }],
});

async function collect(req: StreamRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of new AnthropicDriver().stream(req, { apiKey: "test" })) events.push(event);
  return events;
}

function doneMessage(events: StreamEvent[]): AssistantMessage {
  const done = events.find((event) => event.type === "done");
  expect(done).toBeDefined();
  if (!done || done.type !== "done") throw new Error("Missing done event");
  return done.message;
}

async function wireBody(driver: LlmDriver, req: StreamRequest): Promise<string> {
  const bodies: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    // A terminal HTTP rejection captures formatting without needing protocol-specific response fixtures.
    return new Response("fixture rejection", { status: 400 });
  }) as typeof fetch;
  for await (const _event of driver.stream(req, { apiKey: "test", bearerToken: "test" })) { /* drain */ }
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

describe("Anthropic ordered assistant blocks", () => {
  test("preserves signed blocks, opaque data and start payloads through parse and formatting", async () => {
    globalThis.fetch = (async () => new Response(anthropicSse([...signedBlockFrames, terminal("tool_use")]))) as unknown as typeof fetch;
    const events = await collect(request());
    const message = doneMessage(events);
    expect(message).toEqual(signedAssistant);
    expect(events.filter((event) => event.type === "thinking_delta").map((event) => event.delta).join("")).toBe(signedAssistant.thinking);
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join("")).toBe(signedAssistant.content);
    const body = JSON.parse(await wireBody(new AnthropicDriver(), { ...request(), messages: [message] }));
    expect(body.messages).toEqual([{ role: "assistant", content: signedWireBlocks }]);
  });

  test("formats ordered blocks without reconstructing the legacy aggregates", async () => {
    const body = JSON.parse(await wireBody(new AnthropicDriver(), { ...request(), messages: [signedAssistant] }));
    expect(body.messages).toEqual([{ role: "assistant", content: signedWireBlocks }]);
    const { blocks: _blocks, ...legacy } = signedAssistant;
    const fallback = JSON.parse(await wireBody(new AnthropicDriver(), { ...request(), messages: [legacy] }));
    expect(fallback.messages).toEqual([{ role: "assistant", content: [
      { type: "thinking", thinking: "first thought\nsecond thought", signature: "sig-onesig-two" },
      { type: "text", text: "Before tool.\nAfter tool." },
      { type: "tool_use", id: "call-blocks", name: "read_file", input: { path: "src/llm/types.ts" } },
    ] }]);
  });

  test("omits empty text on the wire while retaining ordered neighbours and parsed fidelity", async () => {
    globalThis.fetch = (async () => new Response(anthropicSse([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "sig" } },
      { type: "content_block_start", index: 2, content_block: { type: "redacted_thinking", data: "opaque" } },
      { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "call", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
      terminal("tool_use"),
    ]))) as unknown as typeof fetch;
    const message = doneMessage(await collect(request()));
    expect(message.blocks).toEqual([
      { type: "text", text: "" },
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "tool_use", id: "call" },
    ]);
    const body = JSON.parse(await wireBody(new AnthropicDriver(), { ...request(), messages: [message] }));
    expect(body.messages[0].content).toEqual([
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "tool_use", id: "call", name: "read_file", input: { path: "a" } },
    ]);
  });

  test("falls back to legacy string for an empty ordered list", async () => {
    for (const content of ["", "legacy text"]) {
      const message: AssistantMessage = { role: "assistant", content, blocks: [] };
      const body = JSON.parse(await wireBody(new AnthropicDriver(), { ...request(), messages: [message] }));
      expect(body.messages[0].content).toBe(content);
    }
  });

  test("falls back to the legacy empty string when the only block is empty text", async () => {
    const message: AssistantMessage = { role: "assistant", content: "", blocks: [{ type: "text", text: "" }] };
    const body = JSON.parse(await wireBody(new AnthropicDriver(), { ...request(), messages: [message] }));
    expect(body.messages[0].content).toBe("");
  });

  test("uses the legacy projection when redacted thinking data is not a string", async () => {
    for (const data of [undefined, null, 42]) {
      globalThis.fetch = (async () => new Response(anthropicSse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "visible" } },
        { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data } },
        terminal("end_turn"),
      ]))) as unknown as typeof fetch;
      const message = doneMessage(await collect(request()));
      expect(message.blocks).toBeUndefined();
      const body = JSON.parse(await wireBody(new AnthropicDriver(), { ...request(), messages: [message] }));
      expect(body.messages[0].content).toEqual([{ type: "text", text: "visible" }]);
    }
  });

  test("keeps streamed tool arguments exact after an empty input start", async () => {
    globalThis.fetch = (async () => new Response(anthropicSse([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
      terminal("tool_use"),
    ]))) as unknown as typeof fetch;
    const message = doneMessage(await collect(request()));
    expect(message.toolCalls?.[0]?.rawArgs).toBe('{"path":"a.ts"}');
    expect(message.toolCalls?.[0]?.args).toEqual({ path: "a.ts" });
  });

  test("routes deltas by their block index, including interleaved tool arguments", async () => {
    const frames = [
      { type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "A", signature: "a" } },
      { type: "content_block_start", index: 7, content_block: { type: "thinking", thinking: "B", signature: "b" } },
      { type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "1" } },
      { type: "content_block_delta", index: 7, delta: { type: "signature_delta", signature: "2" } },
      { type: "content_block_delta", index: 2, delta: { type: "signature_delta", signature: "1" } },
      { type: "content_block_start", index: 8, content_block: { type: "tool_use", id: "a", name: "read_file", input: {} } },
      { type: "content_block_start", index: 9, content_block: { type: "tool_use", id: "b", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 8, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
      { type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: '{"path":"b"}' } },
      terminal("tool_use"),
    ];
    globalThis.fetch = (async () => new Response(anthropicSse(frames))) as unknown as typeof fetch;
    const message = doneMessage(await collect(request()));
    expect(message.blocks).toEqual([
      { type: "thinking", thinking: "A1", signature: "a1" },
      { type: "thinking", thinking: "B", signature: "b2" },
      { type: "tool_use", id: "a" },
      { type: "tool_use", id: "b" },
    ]);
    expect(message.toolCalls).toEqual([
      { id: "a", name: "read_file", args: { path: "a" }, rawArgs: '{"path":"a"}' },
      { id: "b", name: "read_file", args: { path: "b" }, rawArgs: '{"path":"b"}' },
    ]);
  });

  test("keeps tool input delivered in the block start without copying it into blocks", async () => {
    globalThis.fetch = (async () => new Response(anthropicSse([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "start", name: "read_file", input: { path: "start.ts" } } },
      terminal("tool_use"),
    ]))) as unknown as typeof fetch;
    const message = doneMessage(await collect(request()));
    expect(message.blocks).toEqual([{ type: "tool_use", id: "start" }]);
    expect(message.toolCalls?.[0]?.args).toEqual({ path: "start.ts" });
  });

  for (const stop of ["max_tokens", "model_context_window_exceeded", "refusal"]) {
    test(`does not re-emit discarded tool blocks after ${stop}`, async () => {
      globalThis.fetch = (async () => new Response(anthropicSse([...signedBlockFrames, terminal(stop)]))) as unknown as typeof fetch;
      const events = await collect(request());
      const message = doneMessage(events);
      expect(events.some((event) => event.type === "tool_call_end")).toBe(false);
      expect(message.toolCalls).toBeUndefined();
      expect(message.blocks).toEqual(signedAssistant.blocks.filter((block) => block.type !== "tool_use"));
      const body = JSON.parse(await wireBody(new AnthropicDriver(), { ...request(), messages: [message] }));
      expect(body.messages[0].content).toEqual(signedWireBlocks.filter((block) => block.type !== "tool_use"));
    });
  }

  for (const strictStreamEnd of [true, false]) {
    test(`does not authorize truncated tool blocks (${strictStreamEnd ? "strict" : "lenient"})`, async () => {
      const partial = signedBlockFrames.slice(0, 16);
      globalThis.fetch = (async () => new Response(anthropicSse(partial))) as unknown as typeof fetch;
      const events = await collect({ ...request(), strictStreamEnd });
      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(events.some((event) => event.type === "tool_call_end" || event.type === "done")).toBe(false);
    });
  }

  test("keeps complete calls and ordered blocks on an accepted lenient close", async () => {
    globalThis.fetch = (async () => new Response(anthropicSse(signedBlockFrames))) as unknown as typeof fetch;
    expect(doneMessage(await collect({ ...request(), strictStreamEnd: false }))).toEqual(signedAssistant);
  });

  test("falls back without losing text when an abnormal stream omits a block start", async () => {
    globalThis.fetch = (async () => new Response(anthropicSse([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "cutoff", name: "read_file", input: {} } },
      terminal("max_tokens"),
    ]))) as unknown as typeof fetch;
    const message = doneMessage(await collect(request()));
    expect(message.blocks).toBeUndefined();
    expect(message.toolCalls).toBeUndefined();
    const body = JSON.parse(await wireBody(new AnthropicDriver(), { ...request(), messages: [message] }));
    expect(body.messages[0].content).toEqual([{ type: "text", text: "Partial" }]);
  });

  test("removes tool references from the halted message on abort", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async () => new Response(anthropicSse([...signedBlockFrames, terminal("tool_use")]))) as unknown as typeof fetch;
    const events: StreamEvent[] = [];
    for await (const event of new AnthropicDriver().stream({ ...request(), signal: controller.signal }, { apiKey: "test" })) {
      events.push(event);
      if (event.type === "tool_call_delta") controller.abort();
    }
    const message = doneMessage(events);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "abort" });
    expect(message.toolCalls).toEqual([]);
    expect(message.blocks).toEqual(signedAssistant.blocks.slice(0, 4));
    const body = JSON.parse(await wireBody(new AnthropicDriver(), { ...request(), messages: [message] }));
    expect(body.messages[0].content).toEqual(signedWireBlocks.slice(0, 4));
  });
});

for (const [provider, driver] of [
  ["openai", new OpenAICompatibleDriver()],
  ["responses", new OpenAIResponsesDriver()],
  ["google", new GoogleDriver()],
  ["bedrock", new BedrockDriver()],
  ["azure", new AzureDriver()],
] as const) {
  test(`${provider} wire body is byte-identical with and without Anthropic blocks`, async () => {
    const req: StreamRequest = {
      provider, model: "wire-test", baseUrl: "https://provider.invalid/v1", systemPrompt: "system",
      messages: [{ role: "user", content: "read the file" }, signedAssistant,
        { role: "tool_result", toolCallId: "call-blocks", toolName: "read_file", result: "file bytes" }],
      tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
      maxTokens: 1024, temperature: 0.2, reasoningEffort: "high",
    };
    const withBlocks = await wireBody(driver, req);
    const { blocks: _blocks, ...legacy } = signedAssistant;
    const withoutBlocks = await wireBody(driver, { ...req, messages: [req.messages[0]!, legacy, req.messages[2]!] });
    expect(withBlocks).toBe(withoutBlocks);
    expect(withBlocks).not.toContain("opaque+redacted/==");
    expect(withBlocks).not.toContain('"blocks"');
  });
}
