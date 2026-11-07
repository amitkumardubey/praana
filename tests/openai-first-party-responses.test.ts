import { afterEach, describe, expect, it } from "bun:test";
import { streamLlmResponse } from "../src/llm/stream.js";
import { streamGuardPendingListeners, streamGuardPendingTimers } from "../src/llm/stream-guard.js";
import { resetUserProvidersForTests } from "../src/provider-registry.js";
import type { StreamEvent, StreamRequest } from "../src/llm/types.js";

const originalFetch = globalThis.fetch;
const completed = { type: "response.completed", response: { status: "completed" } };
const tool = { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const call = { id: "call_1", name: "read_file", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' };
const added = { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: call.id, name: call.name, arguments: "" } };
const args = { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: call.rawArgs };
const closed = { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: call.rawArgs };
const text = { type: "response.output_text.delta", delta: "Reading." };
const sse = (frames: unknown[]) => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
const chat = () => new Response('data: {"choices":[{"delta":{"content":"Chat answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
const request: StreamRequest = { provider: "openai", model: "gpt-6.1-terra", apiKey: "synthetic-key", messages: [{ role: "user", content: "hi" }] };

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetUserProvidersForTests();
  expect(streamGuardPendingTimers()).toBe(0);
  expect(streamGuardPendingListeners()).toBe(0);
});

async function collect(overrides: Partial<StreamRequest> = {}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamLlmResponse({ ...request, ...overrides })) events.push(event);
  return events;
}

describe("first-party Responses request parity", () => {
  it("sends exact JSON for a reasoning/tools/image turn including previous tool results", async () => {
    let sent: { url: string; headers: Record<string, string>; body: unknown } | undefined;
    globalThis.fetch = (async (url, init) => {
      sent = { url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) };
      return sse([completed]);
    }) as typeof fetch;
    await collect({
      systemPrompt: "Follow project rules.", maxTokens: 4096, reasoningEffort: "high", tools: [tool],
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: [{ type: "text", text: "Inspect this" }, { type: "image", mimeType: "image/png", data: "AAAA" }] },
        { role: "assistant", content: "Reading.", toolCalls: [call] },
        { role: "tool_result", toolCallId: call.id, toolName: call.name, result: "file contents" },
        { role: "user", content: "Explain it" },
      ],
    });
    expect(sent).toEqual({
      url: "https://api.openai.com/v1/responses",
      headers: { authorization: "Bearer synthetic-key", "content-type": "application/json" },
      body: {
        model: "gpt-6.1-terra", input: [
          { role: "user", content: [{ type: "input_text", text: "Inspect this" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
          { role: "assistant", content: "Reading." },
          { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
          { type: "function_call_output", call_id: "call_1", output: "file contents" },
          { role: "user", content: "Explain it" },
        ], stream: true, store: false, instructions: "Follow project rules.\nBe concise.",
        tools: [{ type: "function", ...tool }], tool_choice: "auto",
        reasoning: { effort: "high" }, max_output_tokens: 4096,
      },
    });
  });

  it.each(["minimal", "low", "medium", "high", "xhigh"] as const)("passes the SDK-supported %s effort unchanged", async (reasoningEffort) => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return sse([completed]); }) as typeof fetch;
    await collect({ reasoningEffort, tools: [tool] });
    expect(body.reasoning).toEqual({ effort: reasoningEffort });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it.each([undefined, "off"] as const)("omits unset/off effort and Codex-only defaults (%s)", async (reasoningEffort) => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return sse([completed]); }) as typeof fetch;
    await collect({ reasoningEffort });
    expect(body).toEqual({ model: request.model, input: [{ role: "user", content: "hi" }], stream: true, store: false });
  });

  it("keeps token totals and cached input across partial usage readings", async () => {
    globalThis.fetch = (async () => sse([
      { type: "response.created", response: { usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 6 } } } },
      { type: "response.output_text.delta", delta: "Hi" },
      { type: "response.completed", response: { status: "completed", usage: { output_tokens: 4, total_tokens: 14 } } },
    ])) as typeof fetch;
    const events = await collect();
    expect(events.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", usage: { input: 10, output: 0, totalTokens: 10, cacheReadTokens: 6 } },
      { type: "usage", usage: { input: 10, output: 4, totalTokens: 14, cacheReadTokens: 6 } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop", message: { content: "Hi" } });
  });
});

describe("Responses-to-chat pre-emission fallback", () => {
  it.each([
    { code: "model_not_found", message: "No such model" },
    { code: null, message: "This model is not supported on the Responses endpoint" },
  ])("retries a qualifying 404 once and remembers the model (%j)", async (error) => {
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const model = error.code ? "gpt-6-fallback-code" : "gpt-6-fallback-wording";
    globalThis.fetch = (async (url, init) => {
      urls.push(String(url)); bodies.push(JSON.parse(String(init?.body)));
      return String(url).endsWith("/responses") ? Response.json({ error }, { status: 404 }) : chat();
    }) as typeof fetch;
    for (let i = 0; i < 2; i++) {
      const events = await collect({ model, tools: [tool], maxTokens: 42, reasoningEffort: "high" });
      expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
      expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop", message: { content: "Chat answer" } });
    }
    expect(urls).toEqual(["https://api.openai.com/v1/responses", "https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions"]);
    expect(bodies[0]).toMatchObject({ reasoning: { effort: "high" }, max_output_tokens: 42 });
    expect(bodies[1]).toMatchObject({ reasoning_effort: "high", max_completion_tokens: 42 });
  });

  it.each([400, 401, 403, 422])("does not guess endpoint rejection from status %s", async (status) => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ error: { code: "model_not_found", message: "Model not supported" } }, { status }); }) as typeof fetch;
    const events = await collect({ model: `gpt-6-no-fallback-${status}` });
    expect(calls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", status });
  });

  it("does not retry a generic endpoint 404", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("Not Found", { status: 404 }); }) as typeof fetch;
    const events = await collect({ model: "gpt-6-generic-404" });
    expect(calls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", status: 404 });
  });

  it("surfaces a persistent chat rejection without bouncing back to Responses", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      return Response.json({ error: { code: "model_not_found", message: "Model not supported" } }, { status: 404 });
    }) as typeof fetch;
    const events = await collect({ model: "gpt-6-persistent-rejection" });
    expect(urls).toEqual(["https://api.openai.com/v1/responses", "https://api.openai.com/v1/chat/completions"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 404 });
  });

  it.each([{ prefix: [] }, { prefix: [text] }, { prefix: [added] }, { prefix: [{ type: "response.created", usage: { input_tokens: 1 } }] }])("never retries an in-stream error, even before visible text (%j)", async ({ prefix }) => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return sse([...prefix, { type: "error", error: { status: 404, code: "model_not_found", message: "Model not supported" } }]);
    }) as typeof fetch;
    const events = await collect({ model: "gpt-6-stream-error" });
    expect(calls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", status: 404 });
    expect(events.some((event) => event.type === "tool_call_end")).toBe(false);
  });

  it("does not fall back or remember a model after abort during an HTTP rejection", async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      if (urls.length === 1) { controller.abort(); return Response.json({ error: { code: "model_not_found" } }, { status: 404 }); }
      return sse([completed]);
    }) as typeof fetch;
    expect((await collect({ model: "gpt-6-aborted-rejection", signal: controller.signal })).at(-1)).toMatchObject({ type: "done", reason: "abort" });
    await collect({ model: "gpt-6-aborted-rejection" });
    expect(urls).toEqual(["https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses"]);
  });
});

// Exercise the same #719 guards through the first-party routing facade.
describe("routed Responses stream safety", () => {
  it.each([false, true])("suppresses tools from incomplete streams (closed=%s)", async (close) => {
    globalThis.fetch = (async () => sse([text, added, args, ...(close ? [closed] : []),
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ])) as typeof fetch;
    const events = await collect({ tools: [tool] });
    expect(events.some((event) => event.type === "tool_call_end")).toBe(false);
    expect(events.at(-1)).toMatchObject(close ? { type: "done", reason: "length" } : { type: "error", retryable: false });
  });

  it("does not run a closed tool when the response subsequently fails", async () => {
    globalThis.fetch = (async () => sse([text, added, args, closed, { type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "Rejected" } } }])) as typeof fetch;
    const events = await collect();
    expect(events.some((event) => event.type === "tool_call_end" || event.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", status: 429 });
  });
});
