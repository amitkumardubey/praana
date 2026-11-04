import { afterEach, expect, test } from "bun:test";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import type { StreamRequest } from "../src/llm/types.js";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const request = (model: string, reasoningEffort: StreamRequest["reasoningEffort"] = "high"): StreamRequest => ({ model, provider: "anthropic", messages: [{ role: "user", content: "hi" }], maxTokens: 9000, temperature: 0.5, reasoningEffort });
const sse = [
  { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thought" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
].map(x => `data: ${JSON.stringify(x)}\n\n`).join("");
async function run(req: StreamRequest, reject?: string) {
  const bodies: any[] = [];
  globalThis.fetch = (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return reject && bodies.length === 1 ? new Response(reject, {status: 400}) : new Response(sse); }) as typeof fetch;
  const events = []; for await (const event of new AnthropicDriver().stream(req, {apiKey: "test"})) events.push(event);
  return {bodies, events};
}
test("adaptive Claude 5 request and thinking stream", async () => {
  const {bodies, events} = await run(request("claude-sonnet-5-5"));
  expect(bodies[0]).toEqual({model: "claude-sonnet-5-5", messages: [{role: "user", content: "hi"}], max_tokens: 9000, stream: true, thinking: {type: "adaptive"}, output_config: {effort: "high"}});
  expect(events).toContainEqual({type: "thinking_delta", delta: "thought"});
  expect(events.find(e => e.type === "done")?.message.thinkingSignature).toBe("signed");
});
test("older Claude budget and off requests", async () => {
  const budget = await run(request("claude-3-5-sonnet"));
  expect(budget.bodies[0]).toEqual({model: "claude-3-5-sonnet", messages: [{role: "user", content: "hi"}], max_tokens: 12288, stream: true, thinking: {type: "enabled", budget_tokens: 8192}});
  const off = await run(request("claude-sonnet-5-5", "off"));
  expect(off.bodies[0]).toEqual({model: "claude-sonnet-5-5", messages: [{role: "user", content: "hi"}], max_tokens: 9000, stream: true, temperature: 0.5});
});
test("retry and remember adaptive capability", async () => {
  const first = await run(request("claude-unknown-retry"), 'Use thinking.type.adaptive');
  expect(first.bodies).toHaveLength(2); expect(first.bodies[1].thinking).toEqual({type: "adaptive"});
  const next = await run(request("claude-unknown-retry")); expect(next.bodies[0].thinking).toEqual({type: "adaptive"});
});
