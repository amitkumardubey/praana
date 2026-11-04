import { afterEach, expect, test } from "bun:test";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import type { StreamRequest } from "../src/llm/types.js";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const req = (model: string, baseUrl?: string): StreamRequest => ({model, provider: "openai", baseUrl, messages: [{role: "user", content: "hi"}], tools: [{name: "test", description: "test", parameters: {type: "object"}}], reasoningEffort: "high"});
async function run(request: StreamRequest, rejectCount = 0) {
  const bodies: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length <= rejectCount
      ? Response.json({error: {param: "reasoning_effort", message: "Function tools with reasoning_effort are not supported"}}, {status: 400})
      : new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  const events = [];
  for await (const event of new OpenAICompatibleDriver().stream(request, {apiKey: "test"})) events.push(event);
  return { bodies, events };
}

test("preseeded first party model sends none with tools but gateway does not", async () => {
  expect((await run(req("gpt-6.1-terra"))).bodies[0].reasoning_effort).toBe("none");
  expect((await run(req("gpt-6.1-terra", "https://gateway.example/v1"))).bodies[0].reasoning_effort).toBe("high");
});

test("specific 400 retries with none, streams, and remembers model", async () => {
  const { bodies, events } = await run(req("gpt-future-retry"), 1);
  expect(bodies).toHaveLength(2);
  expect(bodies[0].reasoning_effort).toBe("high");
  expect(bodies[1].reasoning_effort).toBe("none");
  expect(events.some((event) => event.type === "text_delta" && event.delta === "ok")).toBe(true);
  expect(events.at(-1)?.type).toBe("done");
  expect((await run(req("gpt-future-retry"))).bodies[0].reasoning_effort).toBe("none");
  expect((await run(req("gpt-future-retry", "https://gateway.example/v1"))).bodies[0].reasoning_effort).toBe("high");
});

test("form correction composes with the streamed terminal event", async () => {
  const { bodies, events } = await run(req("gpt-form-composition"), 1);
  expect(bodies.map(body => body.reasoning_effort)).toEqual(["high", "none"]);
  expect(events).toContainEqual({ type: "text_delta", delta: "ok" });
  expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop", message: { content: "ok" } });
});

test("off or no tools leaves ordinary requests unchanged", async () => {
  expect((await run({...req("gpt-normal-off"), reasoningEffort: "off"})).bodies[0].reasoning_effort).toBeUndefined();
  expect((await run({...req("gpt-6.1-terra"), tools: []})).bodies[0].reasoning_effort).toBe("high");
});

test("specific 400 retries even when reasoning effort was omitted", async () => {
  const { bodies, events } = await run({...req("gpt-future-omitted"), reasoningEffort: "off"}, 1);
  expect(bodies).toHaveLength(2);
  expect(bodies[0].reasoning_effort).toBeUndefined();
  expect(bodies[1].reasoning_effort).toBe("none");
  expect(events.at(-1)?.type).toBe("done");
});

test("persistent 400 with none is surfaced without another retry", async () => {
  const { bodies, events } = await run(req("gpt-future-persistent"), 3);
  expect(bodies).toHaveLength(2);
  expect(bodies[1].reasoning_effort).toBe("none");
  expect(events.at(-1)?.type).toBe("error");
  const preseeded = await run(req("gpt-6.1-terra"), 3);
  expect(preseeded.bodies).toHaveLength(1);
  expect(preseeded.bodies[0].reasoning_effort).toBe("none");
  expect(preseeded.events.at(-1)?.type).toBe("error");
});
