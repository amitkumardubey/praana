import { afterEach, expect, test } from "bun:test";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import type { AssistantMessage, ConversationMessage, StreamEvent } from "../src/llm/types.js";
import { googleSse, parallelCallParts, SKIP_THOUGHT_SIGNATURE, THOUGHT_SIGNATURE } from "./helpers/google-thought-signature.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function request(provider: string, messages: ConversationMessage[], responseParts: unknown[] = [{ text: "done" }]) {
  let body: any;
  let url = "";
  globalThis.fetch = (async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    return googleSse(responseParts);
  }) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const event of new GoogleDriver().stream({ provider, model: "gemini-test", messages }, { apiKey: "fake-key", bearerToken: "fake-token" })) events.push(event);
  expect(events.filter(event => event.type === "error")).toEqual([]);
  const done = events.find(event => event.type === "done");
  expect(done).toBeDefined();
  return { body, url, events, message: done!.message };
}

for (const provider of ["google", "vertex"]) {
  test(`${provider} captures the first parallel call signature and echoes it only on its part`, async () => {
    const first = await request(provider, [{ role: "user", content: "Read both files" }], [
      { text: "Reading", thoughtSignature: "text-signature-out-of-scope" },
      ...parallelCallParts(),
    ]);
    const calls = first.message.toolCalls!;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveProperty("thoughtSignature", THOUGHT_SIGNATURE);
    expect(calls[1]).not.toHaveProperty("thoughtSignature");
    expect(first.events.filter(event => event.type === "tool_call_end").map(event => event.toolCall)).toEqual(calls);
    const second = await request(provider, [
      { role: "user", content: "Read both files" }, first.message,
      ...calls.map(call => ({ role: "tool_result" as const, toolCallId: call.id, toolName: call.name, result: "contents" })),
    ]);
    expect(second.body.contents[1]).toEqual({ role: "model", parts: [
      { text: "Reading" },
      { functionCall: { name: "read_file", args: { path: "a.txt" } }, thoughtSignature: THOUGHT_SIGNATURE },
      { functionCall: { name: "read_file", args: { path: "b.txt" } } },
    ] });
    expect(second.body.contents[2].parts).toHaveLength(2);
    expect(second.url).toContain(provider === "vertex" ? "aiplatform.googleapis.com" : "generativelanguage.googleapis.com");
  });

  test(`${provider} uses the sentinel only on the first call of each unsigned batch, leaving text-only messages unchanged`, async () => {
    const unsigned: AssistantMessage = { role: "assistant", content: "legacy", toolCalls: [
      { id: "a", name: "read_file", args: { path: "a.txt" } },
      { id: "b", name: "read_file", args: { path: "b.txt" } },
    ] };
    const before = structuredClone(unsigned);
    const { body } = await request(provider, [
      { role: "assistant", content: "text only" },
      { role: "assistant", content: "", toolCalls: [] },
      unsigned, { ...unsigned, content: "another batch" },
    ]);
    expect(body.contents[2].parts).toEqual([
      { text: "legacy" },
      { functionCall: { name: "read_file", args: { path: "a.txt" } }, thoughtSignature: SKIP_THOUGHT_SIGNATURE },
      { functionCall: { name: "read_file", args: { path: "b.txt" } } },
    ]);
    expect(body.contents[3].parts[1].thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
    expect(body.contents.slice(0, 2)).toEqual([
      { role: "model", parts: [{ text: "text only" }] },
      { role: "model", parts: [{ text: "" }] },
    ]);
    expect(unsigned).toEqual(before);
  });

  test(`${provider} preserves a signed subset even when the first call is unsigned`, async () => {
    // Spread metadata also permits this behavior test to execute on older ToolCall types.
    const calls = [
      { id: "a", name: "read_file", args: { path: "a.txt" } },
      { id: "b", name: "read_file", args: { path: "b.txt" }, ...{ thoughtSignature: THOUGHT_SIGNATURE } },
      { id: "c", name: "read_file", args: { path: "c.txt" }, ...{ thoughtSignature: "second-opaque-signature==" } },
    ];
    const { body } = await request(provider, [{ role: "assistant", content: "", toolCalls: calls }]);
    expect(body.contents[0].parts).toEqual(calls.map(call => ({
      functionCall: { name: call.name, args: call.args },
      ...("thoughtSignature" in call ? { thoughtSignature: call.thoughtSignature } : {}),
    })));
    expect(JSON.stringify(body)).not.toContain(SKIP_THOUGHT_SIGNATURE);
  });
}
