import { afterEach, expect, it } from "bun:test";
import { OpenAIResponsesDriver } from "../src/llm/drivers/responses.js";
import type { StreamEvent } from "../src/llm/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function collect(provider: string, frames: unknown[], abortOnArgs = false): Promise<StreamEvent[]> {
  globalThis.fetch = (async () => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""))) as typeof fetch;
  const ac = new AbortController();
  const events: StreamEvent[] = [];
  const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64url")}.sig`;
  for await (const event of new OpenAIResponsesDriver().stream({ provider, model: "m", messages: [{ role: "user", content: "hi" }], signal: ac.signal }, provider === "openai-codex" ? { bearerToken: token } : { apiKey: "fake" })) {
    events.push(event);
    if (abortOnArgs && event.type === "tool_call_delta") ac.abort();
  }
  return events;
}

const text = { type: "response.output_text.delta", delta: "Partial" };
const added = { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } };
const args = (delta: string) => ({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta });
const terminal = (type: string) => ({ type, response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } });

for (const provider of ["openai", "openai-codex"]) {
  for (const type of ["response.incomplete", "response.completed", "response.done"]) {
    for (const closed of [false, true]) {
      it(`${provider}: suppresses tools on ${type} incomplete (call closed: ${closed})`, async () => {
        const frames: unknown[] = [text, added, args(closed ? '{"path":"a.ts"}' : '{"path":"a')];
        if (closed) frames.push(
          { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"path":"a.ts"}' },
          { type: "response.output_item.done", output_index: 1, item: { ...added.item, arguments: '{"path":"a.ts"}' } },
        );
        frames.push(terminal(type));
        const events = await collect(provider, frames);
        expect(events).toContainEqual({ type: "text_delta", delta: "Partial" });
        expect(events.some((event) => event.type === "tool_call_end")).toBe(false);
        expect(events.some((event) => event.type === "usage")).toBe(true);
        if (closed) {
          expect(events.at(-1)).toEqual({ type: "done", reason: "length", message: { role: "assistant", content: "Partial", toolCalls: undefined } });
        } else {
          expect(events.some((event) => event.type === "done")).toBe(false);
          expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
          const last = events.at(-1);
          expect(last?.type === "error" && last.error.message).toBe("The response was cut off while the model was calling a tool");
        }
      });
    }
    it(`${provider}: keeps text-only length on ${type} incomplete`, async () => {
      const events = await collect(provider, [text, terminal(type)]);
      expect(events.at(-1)).toMatchObject({ type: "done", reason: "length", message: { content: "Partial" } });
    });
  }
  it(`${provider}: drops partial tool calls on user abort`, async () => {
    const events = await collect(provider, [text, added, args('{"path":"a'), { type: "response.completed", response: { status: "completed" } }], true);
    expect(events.some((event) => event.type === "tool_call_end")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", reason: "abort", message: { role: "assistant", content: "Partial", toolCalls: [] } });
  });
}
