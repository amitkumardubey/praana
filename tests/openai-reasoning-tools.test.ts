import { afterEach, expect, test } from "bun:test";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import type { StreamRequest } from "../src/llm/types.js";
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const req = (model: string, baseUrl?: string): StreamRequest => ({model, provider: "openai", baseUrl, messages: [{role: "user", content: "hi"}], tools: [{name: "test", description: "test", parameters: {type: "object"}}], reasoningEffort: "high"});
async function run(request: StreamRequest, reject = false) {
  const bodies: any[] = [];
  globalThis.fetch = (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return reject && bodies.length === 1 ? Response.json({error: {param: "reasoning_effort", message: "Function tools with reasoning_effort are not supported"}}, {status: 400}) : new Response("data: [DONE]\n\n"); }) as typeof fetch;
  for await (const _ of new OpenAICompatibleDriver().stream(request, {apiKey: "test"})) {}
  return bodies;
}
test("preseeded first party model skips reasoning with tools but gateway does not", async () => {
  expect((await run(req("gpt-6.1-terra")))[0].reasoning_effort).toBeUndefined();
  expect((await run(req("gpt-6.1-terra", "https://gateway.example/v1")))[0].reasoning_effort).toBe("high");
});
test("specific 400 retries once and remembers model", async () => {
  const bodies = await run(req("gpt-future-retry"), true);
  expect(bodies).toHaveLength(2); expect(bodies[0].reasoning_effort).toBe("high"); expect(bodies[1].reasoning_effort).toBeUndefined();
  expect((await run(req("gpt-future-retry")))[0].reasoning_effort).toBeUndefined();
  expect((await run(req("gpt-future-retry", "https://gateway.example/v1")))[0].reasoning_effort).toBe("high");
});
