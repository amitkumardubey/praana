import { afterEach, beforeEach, expect, test } from "bun:test";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import type { ConversationMessage, StreamEvent, ToolCall } from "../src/llm/types.js";
import { useCleanVertexEnv } from "./helpers/vertex-env.js";
import { googleSse, SKIP_THOUGHT_SIGNATURE, THOUGHT_SIGNATURE } from "./helpers/google-thought-signature.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
useCleanVertexEnv();
// Vertex refuses to build a request without a project; the value is a placeholder.
beforeEach(() => { process.env.VERTEX_PROJECT_ID = "proj-test"; });

async function request(provider: string, model: string, messages: ConversationMessage[]) {
  let body: any;
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return googleSse([{ text: "done" }]);
  }) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const event of new GoogleDriver().stream({ provider, model, messages }, { apiKey: "fake-key", bearerToken: "fake-token" })) events.push(event);
  expect(events.filter(event => event.type === "error")).toEqual([]);
  const done = events.find(event => event.type === "done");
  expect(done).toBeDefined();
  return { body };
}

function unsignedCalls(count: number): ToolCall[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `call-${index}`,
    name: "read_file",
    args: { path: `${String.fromCharCode(97 + index)}.txt` },
  }));
}

function modelContents(body: any) {
  return body.contents.filter((content: any) => content.role === "model");
}

for (const provider of ["google", "vertex"]) {
  for (const model of ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-pro"]) {
    test(`${provider} injects no sentinel for ${model}`, async () => {
      const { body } = await request(provider, model, [
        { role: "user", content: "go" },
        { role: "assistant", content: "working", toolCalls: unsignedCalls(2) },
      ]);
      expect(modelContents(body)[0].parts).toEqual([
        { text: "working" },
        { functionCall: { name: "read_file", args: { path: "a.txt" } } },
        { functionCall: { name: "read_file", args: { path: "b.txt" } } },
      ]);
      expect(JSON.stringify(body)).not.toContain(SKIP_THOUGHT_SIGNATURE);
    });
  }

  // Vertex takes publisher model ids, not slash-containing resource names.
  for (const model of ["gemini-3.8-flash", "gemini-4-hydrogen", "gemini-4-xyz", provider === "google" ? "models/gemini-3.7-flash" : "gemini-3.7-flash", "my-custom-model"]) {
    test(`${provider} injects the sentinel on the first call only for ${model}`, async () => {
      const { body } = await request(provider, model, [
        { role: "user", content: "go" },
        { role: "assistant", content: "working", toolCalls: unsignedCalls(2) },
      ]);
      expect(modelContents(body)[0].parts).toEqual([
        { text: "working" },
        { functionCall: { name: "read_file", args: { path: "a.txt" } }, thoughtSignature: SKIP_THOUGHT_SIGNATURE },
        { functionCall: { name: "read_file", args: { path: "b.txt" } } },
      ]);
    });
  }

  test(`${provider} gates the sentinel to the current turn (after the last user message)`, async () => {
    const oldCalls = unsignedCalls(1);
    const newCalls = unsignedCalls(2);
    const { body } = await request(provider, "gemini-3.8-flash", [
      { role: "user", content: "first" },
      { role: "assistant", content: "old", toolCalls: oldCalls },
      { role: "tool_result", toolCallId: oldCalls[0].id, toolName: "read_file", result: "result" },
      { role: "assistant", content: "interim text" },
      { role: "user", content: "second" },
      { role: "assistant", content: "new", toolCalls: newCalls },
      { role: "tool_result", toolCallId: newCalls[0].id, toolName: "read_file", result: "result" },
    ]);
    const models = modelContents(body);
    // Older turn (before the second user message): unsigned call gets no sentinel.
    expect(models[0].parts).toEqual([
      { text: "old" },
      { functionCall: { name: "read_file", args: { path: "a.txt" } } },
    ]);
    // Interim text-only assistant message stays untouched.
    expect(models[1].parts).toEqual([{ text: "interim text" }]);
    // Current turn (after the second user message): sentinel on the first call only.
    expect(models[2].parts).toEqual([
      { text: "new" },
      { functionCall: { name: "read_file", args: { path: "a.txt" } }, thoughtSignature: SKIP_THOUGHT_SIGNATURE },
      { functionCall: { name: "read_file", args: { path: "b.txt" } } },
    ]);
    expect(JSON.stringify(body)).not.toContain(SKIP_THOUGHT_SIGNATURE + SKIP_THOUGHT_SIGNATURE);
  });

  test(`${provider} echoes a stored signature on gemini-2.0-flash in an older turn`, async () => {
    const { body } = await request(provider, "gemini-2.0-flash", [
      { role: "user", content: "first" },
      { role: "assistant", content: "old", toolCalls: [
        { id: "a", name: "read_file", args: { path: "a.txt" }, thoughtSignature: THOUGHT_SIGNATURE },
      ] },
      { role: "tool_result", toolCallId: "a", toolName: "read_file", result: "result" },
      { role: "user", content: "second" },
    ]);
    expect(modelContents(body)[0].parts).toEqual([
      { text: "old" },
      { functionCall: { name: "read_file", args: { path: "a.txt" } }, thoughtSignature: THOUGHT_SIGNATURE },
    ]);
    expect(JSON.stringify(body)).not.toContain(SKIP_THOUGHT_SIGNATURE);
  });

  test(`${provider} echoes a stored signature on an older turn under a signature-requiring model`, async () => {
    const { body } = await request(provider, "gemini-3.8-flash", [
      { role: "user", content: "first" },
      { role: "assistant", content: "old", toolCalls: [
        { id: "a", name: "read_file", args: { path: "a.txt" }, thoughtSignature: THOUGHT_SIGNATURE },
      ] },
      { role: "tool_result", toolCallId: "a", toolName: "read_file", result: "result" },
      { role: "user", content: "second" },
    ]);
    expect(modelContents(body)[0].parts).toEqual([
      { text: "old" },
      { functionCall: { name: "read_file", args: { path: "a.txt" } }, thoughtSignature: THOUGHT_SIGNATURE },
    ]);
    expect(JSON.stringify(body)).not.toContain(SKIP_THOUGHT_SIGNATURE);
  });
}
