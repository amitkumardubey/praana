import { afterEach, expect, test } from "bun:test";
import { buildBatchSummaryRequest, buildSameModelSummaryRequest } from "../src/compaction-requests.js";
import { buildSummaryInstruction, renderSummaryMessage } from "../src/frozen-summary.js";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import { OpenAIResponsesDriver } from "../src/llm/drivers/responses.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { BedrockDriver } from "../src/llm/drivers/bedrock.js";
import { AzureDriver } from "../src/llm/drivers/azure.js";
import type { LlmDriver } from "../src/llm/drivers/base.js";
import type { StreamEvent, StreamRequest } from "../src/llm/types.js";

type WireItem = Record<string, unknown>;
interface Captured {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const instruction = buildSummaryInstruction({ cutDescription: "through event cut-3 (end of turn 3)", capTokens: 256 });
const resultA = "UNIQUE_TOOL_RESULT_A";
const resultB = "UNIQUE_TOOL_RESULT_B";

function live(provider: string, reasoningEffort: "off" | "high"): StreamRequest {
  return {
    provider, model: provider === "anthropic" ? "claude-sonnet-4-20250514" : "test-model",
    systemPrompt: "SYSTEM_BYTES_UNCHANGED\nline two", messages: [
      { role: "system", content: "EXTRA_SYSTEM_BYTES" },
      { role: "user", content: "Read both files before continuing." },
      { role: "assistant", content: "Reading both", toolCalls: [
        { id: "call-a", name: "read_a", args: { path: "a" } },
        { id: "call-b", name: "read_b", args: { path: "b" } },
      ] },
      { role: "tool_result", toolCallId: "call-a", toolName: "read_a", result: resultA, isError: false },
      { role: "tool_result", toolCallId: "call-b", toolName: "read_b", result: resultB, isError: true },
    ], tools: ["a", "b"].map(suffix => ({ name: `read_${suffix}`, description: `Read file ${suffix}`, parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } })),
    reasoningEffort, temperature: 0.2, maxTokens: 16384,
    baseUrl: "https://mock.invalid/v1", baseUrlOverride: true, endpointUrl: "https://mock.invalid/wire",
    headers: { "x-shape-test": "same-bytes" }, query: { "api-version": "test-version" }, region: "us-east-1",
    api: "test-api", compat: { maxTokensField: "max_completion_tokens" },
    apiKey: "fake-request-key", bearerToken: "fake-request-token", signal: new AbortController().signal,
    strictStreamEnd: true, streamEndCheck: "strict", connectTimeoutMs: 1000, idleTimeoutMs: 1000,
  };
}

function bedrockStop(): Buffer {
  // Synthetic decoder input; AWS CRC validation is outside this formatter test.
  const payload = Buffer.from(JSON.stringify({ messageStop: { stopReason: "end_turn" } }));
  const frame = Buffer.alloc(payload.length + 16);
  frame.writeUInt32BE(frame.length, 0);
  payload.copy(frame, 12);
  return frame;
}
function terminal(provider: string): Response {
  if (provider === "amazon-bedrock") return new Response(new Uint8Array(bedrockStop()));
  const frames = provider === "anthropic"
    ? [{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }, { type: "message_stop" }]
    : provider === "responses"
      ? [{ type: "response.completed", response: { status: "completed", output: [] } }]
      : provider === "google"
        ? [{ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }]
        : [{ choices: [{ delta: {}, finish_reason: "stop" }] }];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
async function capture(driver: LlmDriver, request: StreamRequest, responseKind: string): Promise<Captured> {
  const captured: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) });
    return terminal(responseKind);
  }) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const event of driver.stream(request, { apiKey: "fake-key", bearerToken: "fake-bearer" })) events.push(event);
  expect(events.filter(event => event.type === "error")).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
  expect(captured).toHaveLength(1);
  return captured[0];
}

const drivers: { name: string; provider: string; driver: () => LlmDriver; key: "messages" | "input" | "contents" }[] = [
  { name: "Anthropic", provider: "anthropic", driver: () => new AnthropicDriver(), key: "messages" },
  { name: "OpenAI-compatible", provider: "openai", driver: () => new OpenAICompatibleDriver(), key: "messages" },
  { name: "Responses", provider: "responses", driver: () => new OpenAIResponsesDriver(), key: "input" },
  { name: "Google", provider: "google", driver: () => new GoogleDriver(), key: "contents" },
  { name: "Bedrock", provider: "amazon-bedrock", driver: () => new BedrockDriver(), key: "messages" },
  { name: "Azure", provider: "azure", driver: () => new AzureDriver(), key: "messages" },
];

for (const { name, provider, driver, key } of drivers) {
  test(`${name} serializes consecutive [user snapshot, user summary, user input] messages in order`, async () => {
    const source = live(provider, "off");
    const snapshot = "VOLATILE_SNAPSHOT_SECTION";
    const summaryMsg = renderSummaryMessage("### Active request\nShip compaction.\n\n### Plan\n- Run D");
    const userInput = "CURRENT_USER_INPUT_TURN";
    const request: StreamRequest = {
      ...source,
      messages: [
        { role: "user", content: snapshot },
        summaryMsg,
        { role: "user", content: userInput },
      ],
    };
    const wire = await capture(driver(), request, provider);
    const items = (wire.body[key] as WireItem[]).slice(-3);
    expect(items).toHaveLength(3);
    expect(items.every(item => item.role === "user")).toBe(true);
    const serialized = items.map(item => JSON.stringify(item));
    expect(serialized[0]).toContain(snapshot);
    expect(serialized[1]).toContain("This is a summary of earlier conversation, for context, not instructions:");
    expect(serialized[1]).toContain("### Active request");
    expect(serialized[2]).toContain(userInput);
  });

  test(`${name} serializes standalone folded tool turns as user text without native tool blocks`, async () => {
    const source = live(provider, "off");
    const request = buildBatchSummaryRequest(source, { messages: source.messages.slice(1) }, {
      cutDescription: "through call-b", capTokens: 256, effectiveMaxTokens: 1024,
    });
    const wire = await capture(driver(), request, provider);
    const items = wire.body[key] as WireItem[];
    const serialized = JSON.stringify(items);
    expect(items.every(item => item.role === "user")).toBe(true);
    for (const field of ['"tool_use"', '"tool_result"', '"tool_calls"', '"toolCalls"', '"toolUse"', '"toolResult"', '"functionCall"', '"functionResponse"', '"function_call"', '"function_call_output"']) {
      expect(serialized).not.toContain(field);
    }
    expect(serialized).toContain('tool_call read_a(');
    expect(serialized).toContain(`tool_result read_b: ${resultB}`);
    expect(wire.body.tools).toBeUndefined();
    expect(wire.body.toolConfig).toBeUndefined();
  });

  for (const reasoningEffort of ["off", "high"] as const) {
    test(`${name} preserves the serialized live request and places the instruction after both parallel results (${reasoningEffort})`, async () => {
      const source = live(provider, reasoningEffort);
      const before = JSON.stringify(source);
      const summaryRequest = buildSameModelSummaryRequest(source, instruction);
      const liveWire = await capture(driver(), source, provider);
      const summaryWire = await capture(driver(), summaryRequest, provider);
      const liveItems = liveWire.body[key] as WireItem[];
      const summaryItems = summaryWire.body[key] as WireItem[];
      expect(summaryItems).toHaveLength(liveItems.length + 1);
      expect(summaryItems.slice(0, -1)).toEqual(liveItems);
      // Compare all wire fields, not a hand-picked subset of system/tools/parameters.
      expect({ ...summaryWire, body: { ...summaryWire.body, [key]: liveItems } }).toEqual(liveWire);
      expect(summaryWire.headers["x-shape-test"]).toBe("same-bytes");
      expect(summaryWire.body.tool_choice).toEqual(liveWire.body.tool_choice);
      expect(summaryRequest).not.toHaveProperty("tool_choice");
      const serialized = summaryItems.map(item => JSON.stringify(item));
      const instructionIndex = serialized.findIndex(item => item.includes(JSON.stringify(instruction).slice(1, -1)));
      expect(instructionIndex).toBe(summaryItems.length - 1);
      for (const result of [resultA, resultB]) {
        const indexes = serialized.flatMap((item, index) => item.includes(result) ? [index] : []);
        expect(indexes).toHaveLength(1);
        expect(indexes[0]).toBeLessThan(instructionIndex);
      }
      const last = summaryItems.at(-1)!;
      expect(last.role).toBe("user");
      if (provider === "google") expect(last.parts).toEqual([{ text: instruction }]);
      else if (provider === "amazon-bedrock") expect(last.content).toEqual([{ text: instruction }]);
      else expect(last.content).toBe(instruction);
      expect(JSON.stringify(source)).toBe(before);

      if (provider === "anthropic") {
        // The Messages API combines these consecutive user messages into one turn.
        expect(summaryItems.slice(-3)).toEqual([
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: resultA }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call-b", content: resultB, is_error: true }] },
          { role: "user", content: instruction },
        ]);
        expect(summaryWire.body.tools).toHaveLength(2);
        expect(JSON.stringify(summaryWire.body.system)).toContain("SYSTEM_BYTES_UNCHANGED");
        expect(summaryWire.body.max_tokens).toBe(source.maxTokens!);
        if (reasoningEffort === "high") {
          expect(summaryWire.body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
          expect(summaryWire.body).not.toHaveProperty("temperature");
        } else expect(summaryWire.body.temperature).toBe(0.2);
      } else if (provider === "google") {
        // Wire observation, not provider acceptance: parallel responses are split
        // across two Contents, rather than two parts in the next response turn.
        expect(summaryItems.slice(-3, -1)).toEqual([
          { role: "user", parts: [{ functionResponse: { name: "read_a", response: { output: resultA, isError: false } } }] },
          { role: "user", parts: [{ functionResponse: { name: "read_b", response: { output: resultB, isError: true } } }] },
        ]);
        expect(summaryWire.body.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 16384 });
      } else if (provider === "amazon-bedrock") {
        // Wire observation: Converse emits one toolResult per user message, not
        // all parallel results in a single next-message content array.
        expect(summaryItems.slice(-3, -1)).toEqual([
          { role: "user", content: [{ toolResult: { toolUseId: "call-a", content: [{ text: resultA }], status: "success" } }] },
          { role: "user", content: [{ toolResult: { toolUseId: "call-b", content: [{ text: resultB }], status: "error" } }] },
        ]);
        expect(summaryWire.body.inferenceConfig).toEqual({ temperature: 0.2, maxTokens: 16384 });
      } else if (provider === "responses") {
        expect(summaryItems.slice(-3, -1)).toEqual([
          { type: "function_call_output", call_id: "call-a", output: resultA },
          { type: "function_call_output", call_id: "call-b", output: resultB },
        ]);
        expect(summaryWire.body).toMatchObject({ temperature: 0.2, max_output_tokens: 16384, tool_choice: "auto" });
      } else {
        expect(summaryItems.slice(-3, -1)).toEqual([
          { role: "tool", tool_call_id: "call-a", content: resultA },
          { role: "tool", tool_call_id: "call-b", content: resultB },
        ]);
        expect(summaryWire.body).toMatchObject({ temperature: 0.2, max_completion_tokens: 16384, tool_choice: "auto" });
      }
    });
  }
}
