import { expect, test } from "bun:test";
import { buildSummaryInstruction } from "../src/frozen-summary.js";
import type { StreamRequest } from "../src/llm/types.js";

const api = () => import("../src/compaction-requests.js");
const instructionOptions = { cutDescription: "through event folded-7 (end of turn 3)", capTokens: 256 };

function liveRequest(): StreamRequest {
  return {
    model: "same-model", provider: "custom", systemPrompt: "unchanged system",
    messages: [
      { role: "user", content: "current input" },
      { role: "assistant", content: "Reading both", toolCalls: [
        { id: "call-a", name: "read", args: { path: "a" } },
        { id: "call-b", name: "read", args: { path: "b" } },
      ] },
      { role: "tool_result", toolCallId: "call-b", toolName: "read", result: "result B" },
      { role: "tool_result", toolCallId: "call-a", toolName: "read", result: "result A", isError: false },
    ],
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    signal: new AbortController().signal, reasoningEffort: "high", temperature: 0.3, maxTokens: 8192,
    baseUrl: "https://mock.invalid/v1", baseUrlOverride: true, headers: { "x-test": "unchanged" },
    compat: { maxTokensField: "max_completion_tokens" }, region: "us-east-1", api: "custom-api",
    query: { version: "1" }, endpointUrl: "https://mock.invalid/request",
    apiKey: "fake-key", bearerToken: "fake-token", strictStreamEnd: true, streamEndCheck: "strict",
    connectTimeoutMs: 100, idleTimeoutMs: 200,
  };
}

test("same-model request preserves every field and appends exactly one schema instruction after parallel results", async () => {
  const { buildSameModelSummaryRequest } = await api();
  const live = liveRequest();
  const before = JSON.stringify(live);
  Object.freeze(live.messages);
  Object.freeze(live);
  const request = buildSameModelSummaryRequest(live, instructionOptions);
  expect(request).not.toBe(live);
  expect(request.messages).not.toBe(live.messages);
  expect(request.messages).toEqual([...live.messages, { role: "user", content: buildSummaryInstruction(instructionOptions) }]);
  for (const key of Object.keys(live) as (keyof StreamRequest)[]) {
    if (key !== "messages") expect(request[key]).toBe(live[key]);
  }
  for (let i = 0; i < live.messages.length; i++) expect(request.messages[i]).toBe(live.messages[i]);
  expect(Object.keys(request).sort()).toEqual(Object.keys(live).sort());
  expect(request).not.toHaveProperty("tool_choice");
  expect(JSON.stringify(live)).toBe(before);
});

test("same-model request accepts the exact prebuilt instruction bytes, without transport defaults", async () => {
  const { buildSameModelSummaryRequest } = await api();
  const live: StreamRequest = { model: "m", provider: "p", messages: [] };
  const instruction = buildSummaryInstruction({ ...instructionOptions, previousSummary: "prior bytes\n雪" });
  expect(buildSameModelSummaryRequest(live, instruction)).toEqual({ ...live, messages: [{ role: "user", content: instruction }] });
  expect(Object.keys(buildSameModelSummaryRequest(live, instruction)).sort()).toEqual(["messages", "model", "provider"]);
  expect(live.messages).toEqual([]);
});

test("same-model instruction options use the frozen summary schema, previous summary and state objects", async () => {
  const { buildSameModelSummaryRequest } = await api();
  const options = { ...instructionOptions, previousSummary: "previous markdown", stateObjects: [] };
  const request = buildSameModelSummaryRequest(liveRequest(), options);
  const message = request.messages.at(-1)!;
  expect(message).toEqual({ role: "user", content: buildSummaryInstruction(options) });
  if (message.role !== "user" || typeof message.content !== "string") throw new Error("Expected instruction");
  for (const text of [options.cutDescription, options.previousSummary, "State objects (data)", "Rewrite the whole block", "Do not call tools"]) expect(message.content).toContain(text);
});
