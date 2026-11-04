import { afterEach, expect, it } from "bun:test";
import { isDefaultHostedEndpoint } from "../src/llm/stream-end.js";
import { withPreEmissionRetry } from "../src/llm/retry.js";
import { OpenAIResponsesDriver } from "../src/llm/drivers/responses.js";
import type { StreamEvent } from "../src/llm/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it("does not classify a different port or protocol as the hosted endpoint", () => {
  expect(isDefaultHostedEndpoint("openai", "http://api.openai.com:8443/v1")).toBe(false);
  expect(isDefaultHostedEndpoint("openai", "http://api.openai.com/v1")).toBe(false);
});

it("counts separately capped error classes independently", async () => {
  class First extends Error { constructor() { super("network error"); } }
  class Second extends Error { constructor() { super("network error"); } }
  let attempts = 0;
  const result = await withPreEmissionRetry(async () => {
    attempts++;
    if (attempts === 1) throw new First();
    if (attempts === 2) throw new Second();
    return "ok";
  }, { maxRetries: 3, maxRetriesFor: () => 1, baseDelayMs: 0, maxDelayMs: 0 });
  expect(result).toBe("ok");
  expect(attempts).toBe(3);
});

it("uses announced arguments instead of duplicating buffered early deltas", async () => {
  const frames = [
    { type: "response.function_call_arguments.delta", item_id: "item1", delta: '{"path":' },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item1", call_id: "call1", name: "read_file", arguments: '{"path":"a.ts"}' } },
    { type: "response.function_call_arguments.done", output_index: 0 },
    { type: "response.completed", response: { status: "completed" } },
  ];
  globalThis.fetch = (async () => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""))) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const event of new OpenAIResponsesDriver().stream({ provider: "openai", model: "m", messages: [{ role: "user", content: "hi" }] }, { apiKey: "fake" })) events.push(event);
  expect(events.filter((e) => e.type === "tool_call_delta").map((e) => e.type === "tool_call_delta" && e.argsDelta)).toEqual(['{"path":"a.ts"}']);
  const end = events.find((e) => e.type === "tool_call_end");
  expect(end?.type === "tool_call_end" && end.toolCall.args).toEqual({ path: "a.ts" });
});
