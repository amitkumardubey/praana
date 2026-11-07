import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createProvider, getReasoningEffort } from "../src/llm.js";
import { runLlmStream, type LlmStreamInput } from "../src/turn.js";
import { resetUserProvidersForTests } from "../src/provider-registry.js";
import { streamGuardPendingListeners, streamGuardPendingTimers } from "../src/llm/stream-guard.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetUserProvidersForTests();
  expect(streamGuardPendingTimers()).toBe(0);
  expect(streamGuardPendingListeners()).toBe(0);
});
const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const fixture = () => readFileSync(join(import.meta.dir, "fixtures/openai-first-party-responses.sse"), "utf8");
function input(overrides: Partial<LlmStreamInput> = {}, base_url?: string): LlmStreamInput {
  const model = createProvider({ provider: "openai", model: "gpt-6.1-terra", ...(base_url !== undefined ? { base_url } : {}) })("gpt-6.1-terra");
  model.__piOptions = { ...model.__piOptions, apiKey: "synthetic-key" };
  return { model, modelName: "gpt-6.1-terra", providerName: "openai", compiledPrompt: "Follow project rules.",
    history: [{ role: "user", content: "Read README.md" }], piTools: tools,
    reasoningEffort: getReasoningEffort(model, "gpt-6.1-terra", "openai", "high"), ...overrides };
}

describe("first-party Responses through the turn adapter", () => {
  it("streams thinking/text/function call/usage/completed and round-trips the resulting tool output", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response(calls.length === 1 ? fixture() : 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Done."}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":40,"output_tokens":2,"total_tokens":42}}}\n\n');
    }) as typeof fetch;
    const text: string[] = [], thinking: string[] = [], usage: unknown[] = [];
    const first = await runLlmStream(input({ onTextDelta: (d) => text.push(d), onThinkingDelta: (d) => thinking.push(d), onProviderUsage: (u) => usage.push(u.step) }));
    expect(text).toEqual(["Reading ", "README.md."]);
    expect(thinking).toEqual(["Inspect the file."]);
    expect(first.finalReason).toBe("toolUse");
    expect(first.errorMessage).toBeUndefined();
    expect(first.pendingToolCalls).toEqual([{ toolName: "read_file", toolCallId: "call_read", args: { path: "README.md" } }]);
    expect(first.providerUsage).toEqual({ input: 30, output: 8, totalTokens: 38, cacheReadTokens: 12 });
    expect(usage).toEqual([first.providerUsage]);
    expect(first.doneReceived).toBe(true);
    const second = await runLlmStream(input({ history: [
      { role: "user", content: "Read README.md" }, first.finalMessage,
      { role: "toolResult", toolCallId: "call_read", toolName: "read_file", content: [{ type: "text", text: "# PRAANA" }] },
    ] }));
    expect(second.finalReason).toBe("stop");
    expect(second.fullResponse).toBe("Done.");
    expect(calls.map((c) => c.url)).toEqual(["https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses"]);
    expect(calls[1]!.body.input).toEqual([
      { role: "user", content: "Read README.md" },
      { role: "assistant", content: "Reading README.md." },
      { type: "function_call", call_id: "call_read", name: "read_file", arguments: '{"path":"README.md"}' },
      { type: "function_call_output", call_id: "call_read", output: "# PRAANA" },
    ]);
    for (const call of calls) {
      expect(call.body.reasoning).toEqual({ effort: "high" });
      expect(call.body.max_output_tokens).toBe(8192);
      for (const header of ["chatgpt-account-id", "originator", "OpenAI-Beta"]) expect(call.headers.has(header)).toBe(false);
    }
  });

  it.each(["https://api.openai.com/v1", "https://gateway.example/v1"])("preserves llm.base_url through buildModel → turn → stream (%s)", async (base_url) => {
    let url = "";
    globalThis.fetch = (async (u) => { url = String(u); return new Response("data: [DONE]\n\n"); }) as typeof fetch;
    await runLlmStream(input({}, base_url));
    expect(url).toBe(`${base_url}/chat/completions`);
  });

  it.each(["auto", "strict", "lenient"] as const)("preserves %s stream-end semantics without a terminal event", async (streamEndCheck) => {
    globalThis.fetch = (async () => new Response(fixture().split("event: response.completed")[0])) as typeof fetch;
    const result = await runLlmStream(input({ streamEndCheck }));
    expect(result.fullResponse).toBe("Reading README.md.");
    if (streamEndCheck === "lenient") {
      expect(result.finalReason).toBe("toolUse");
      expect(result.pendingToolCalls).toHaveLength(1);
    } else {
      expect(result.finalReason).toBe("error");
      expect(result.errorKind).toBe("premature_end");
      expect(result.pendingToolCalls).toEqual([]);
    }
  });

  it.each(["response.incomplete", "response.failed"])("does not enqueue tools after %s", async (type) => {
    const terminal = type === "response.incomplete"
      ? { type, response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }
      : { type, response: { status: "failed", error: { code: "server_error", message: "Failed" } } };
    globalThis.fetch = (async () => new Response(fixture().split("event: response.completed")[0] + `data: ${JSON.stringify(terminal)}\n\n`)) as typeof fetch;
    const result = await runLlmStream(input());
    expect(result.pendingToolCalls).toEqual([]);
    expect(result.finalReason).toBe(type === "response.incomplete" ? "length" : "error");
  });

  it("aborts mid-stream without finishing or enqueuing tools or retrying", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(fixture()); }) as typeof fetch;
    const result = await runLlmStream(input({ signal: controller.signal, onTextDelta: () => controller.abort() }));
    expect(result.fullResponse).toBe("Reading ");
    expect(result.interrupted).toBe(true);
    expect(result.pendingToolCalls).toEqual([]);
    expect(calls).toBe(1);
  });

  it("retains the gpt-6.1 tools workaround on fallback and does not contaminate other models", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body });
      if (body.model === "gpt-6.1-integration-rejection" && String(url).endsWith("/responses")) {
        return Response.json({ error: { code: "model_not_found", message: "Unsupported model" } }, { status: 404 });
      }
      return new Response(String(url).endsWith("/responses") ? fixture() : "data: [DONE]\n\n");
    }) as typeof fetch;
    const rejected = input({ modelName: "gpt-6.1-integration-rejection" });
    await runLlmStream(rejected);
    await runLlmStream(rejected);
    await runLlmStream(input());
    expect(calls.map((c) => c.url.split("/v1/")[1])).toEqual(["responses", "chat/completions", "chat/completions", "responses"]);
    expect(calls[0]!.body.reasoning).toEqual({ effort: "high" });
    expect(calls[1]!.body).toMatchObject({ reasoning_effort: "none", max_completion_tokens: 8192 });
    expect(calls[2]!.body.reasoning_effort).toBe("none");
    expect(calls[3]!.body.reasoning).toEqual({ effort: "high" });
  });
});
