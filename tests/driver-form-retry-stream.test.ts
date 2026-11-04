import { afterEach, expect, test } from "bun:test";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import type { StreamRequest } from "../src/llm/types.js";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
for (const provider of ["anthropic", "openai"] as const) {
  const driver = provider === "anthropic" ? new AnthropicDriver() : new OpenAICompatibleDriver();
  const req = (): StreamRequest => ({ provider, model: provider === "anthropic" ? "claude-form-guard-test" : "gpt-form-guard-test", messages: [{role: "user", content: "hi"}], reasoningEffort: "high", tools: [{name: "t", description: "t", parameters: {type: "object"}}] });
  test(`${provider} does not retry stream errors after emission`, async () => {
    let calls = 0;
    const frames = provider === "anthropic"
      ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"thinking.type.adaptive"}}\n\n'
      : 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"error":{"code":400,"param":"reasoning_effort","message":"Function tools with reasoning_effort"}}\n\n';
    globalThis.fetch = (async () => { calls++; return new Response(frames); }) as typeof fetch;
    const events = []; for await (const ev of driver.stream(req(), {apiKey: "test"})) events.push(ev);
    expect(calls).toBe(1); expect(events.map(e => e.type)).toEqual(["text_delta", "error"]);
  });
  test(`${provider} does not retry form rejection after abort`, async () => {
    let calls = 0; const controller = new AbortController();
    globalThis.fetch = (async () => { calls++; controller.abort(); return provider === "anthropic" ? new Response("thinking.type.adaptive", {status:400}) : Response.json({error:{param:"reasoning_effort",message:"Function tools with reasoning_effort"}}, {status:400}); }) as typeof fetch;
    const events = []; for await (const ev of driver.stream({...req(), signal: controller.signal}, {apiKey:"test"})) events.push(ev);
    expect(calls).toBe(1); expect(events.at(-1)).toMatchObject({type:"done", reason:"abort"});
  });
}
