import { afterEach, describe, expect, it } from "bun:test";
import { createProvider, getReasoningEffort } from "../src/llm.js";
import { openaiUsesResponses } from "../src/llm/openai-routing.js";
import { getDriverForProvider } from "../src/llm/resolver.js";
import { streamLlmResponse } from "../src/llm/stream.js";
import { resetUserProvidersForTests, setUserProviders } from "../src/provider-registry.js";
import type { StreamEvent, StreamRequest } from "../src/llm/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; resetUserProvidersForTests(); });

const table: Array<[string, boolean]> = [
  ["gpt-5.3", false], ["gpt-5.3-codex", false], ["gpt-5.4", true],
  ["gpt-5.4-mini", true], ["gpt-5.4-nano", true], ["gpt-5.4-pro", true],
  ["gpt-5.4-2026-03-05", true], ["gpt-5.5", true], ["gpt-5.5-pro", true],
  ["gpt-5.6-luna", true], ["gpt-5.6-sol", true], ["gpt-5.6-terra", true],
  ["gpt-5.10", true], ["gpt-6-astra", true], ["gpt-6-luna", true], ["gpt-6-sol", true],
  ["gpt-6.1-sol", true], ["gpt-6.1-terra", true], ["gpt-6", true],
  ["gpt-4o", false], ["gpt-4.1", false], ["o3-mini", false], ["gpt-3.5-turbo", false],
  ["gpt-4", false], ["gpt-5", false], ["gpt-5-mini", false], ["gpt-5.1", false],
  ["gpt-5.2", false], ["unknown", false], ["claude-sonnet-4-6", false],
  ["gpt-60", false], ["gpt-7", false], ["gpt-5.04", false], ["gpt-5.4foo", false],
  ["openai/gpt-6-luna", false], ["GPT-6-LUNA", false],
  // Non-text-generation variants stay on Chat Completions.
  ["gpt-5.4-audio", false], ["gpt-5.4-realtime", false], ["gpt-5.4-realtime-preview", false],
  ["gpt-5.4-transcribe", false], ["gpt-5.4-tts", false], ["gpt-5.4-tts-1", false],
  ["gpt-5.4-image", false], ["gpt-5.4-embedding", false], ["gpt-5.4-embeddings", false],
  ["gpt-5.4-moderation", false], ["gpt-5.4-search", false], ["gpt-5.4-chat-latest", false],
  ["gpt-6.1-image", false], ["gpt-6-realtime", false], ["gpt-6.1-transcribe", false],
];

describe("OpenAI Responses routing floor (not a support list)", () => {
  it.each(table)("%s → %s", (id, expected) => expect(openaiUsesResponses(id)).toBe(expected));

  it.each(table.filter(([id]) => !id.includes("/")))("buildModel selects the protocol for %s", (id, expected) => {
    const model = createProvider({ provider: "openai", model: id })(id);
    expect(model.api).toBe(expected ? "openai-responses" : "openai-completions");
  });

  it("normalizes the provider prefix before testing the floor and enables reasoning", () => {
    const model = createProvider({ provider: "openai", model: "gpt-6.1-terra" })("openai/gpt-6.1-terra");
    expect(model.id).toBe("gpt-6.1-terra");
    expect(model.api).toBe("openai-responses");
    expect(getReasoningEffort(model, String(model.id), "openai", "high")).toBe("high");
  });

  it.each(["https://gateway.example/v1", "https://api.openai.com/v1"])("preserves configured base_url %s", (base_url) => {
    const model = createProvider({ provider: "openai", model: "gpt-6.1-terra", base_url })("gpt-6.1-terra");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrlOverride).toBe(true);
    expect((model.compat as Record<string, unknown>).maxTokensField).toBeUndefined();
  });

  it("treats an empty llm.base_url as unset", () => {
    const model = createProvider({ provider: "openai", model: "gpt-6.1-terra", base_url: "" })("gpt-6.1-terra");
    expect(model.api).toBe("openai-responses");
    expect(model.baseUrl).toBe("https://api.openai.com/v1");
    expect(model.baseUrlOverride).toBeUndefined();
    expect(getReasoningEffort(model, "gpt-6.1-terra", "openai", "off", { firstPartyResponses: true })).toBe("none");
  });

  it.each(["umans", "poolside", "ollama", "openrouter", "custom"])("does not change %s", (provider) => {
    const model = createProvider({ provider, model: "gpt-6.1-terra" })("gpt-6.1-terra");
    expect(model.api).toBe("openai-completions");
  });

  it("does not change Anthropic's driver", () => {
    expect(getDriverForProvider("anthropic").protocol).toBe("anthropic-messages");
  });
});

async function collect(request: Partial<StreamRequest> = {}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamLlmResponse({
    provider: "openai", model: "gpt-6.1-terra", apiKey: "synthetic-key",
    messages: [{ role: "user", content: "hi" }], ...request,
  })) events.push(event);
  return events;
}

it("routes direct requests through Responses, but endpoint/base URL overrides stay on chat", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  await collect();
  await collect({ endpointUrl: "https://api.openai.com/v1/chat/completions" });
  await collect({ baseUrl: "https://gateway.example/v1" });
  await collect({ baseUrl: "https://api.openai.com/v1", baseUrlOverride: true });
  await collect({ model: "gpt-4o" });
  expect(urls).toEqual([
    "https://api.openai.com/v1/responses", "https://api.openai.com/v1/chat/completions",
    "https://gateway.example/v1/chat/completions", "https://api.openai.com/v1/chat/completions",
    "https://api.openai.com/v1/chat/completions",
  ]);
});

it("honors a user-declared provider even when its id and URL are the built-in openai", async () => {
  setUserProviders({ openai: { api: "openai-completions", base_url: "https://api.openai.com/v1", env_key: "OPENAI_API_KEY" } });
  const model = createProvider({ provider: "openai", model: "gpt-6.1-terra" })("gpt-6.1-terra");
  expect(model.api).toBe("openai-completions");
  const urls: string[] = [];
  globalThis.fetch = (async (url) => { urls.push(String(url)); return new Response("data: [DONE]\n\n"); }) as typeof fetch;
  await collect();
  expect(urls).toEqual(["https://api.openai.com/v1/chat/completions"]);
});

describe("reasoning effort routing awareness", () => {
  const firstParty = createProvider({ provider: "openai", model: "gpt-6.1-terra" })("gpt-6.1-terra");

  it("maps off to none on first-party Responses and keeps other levels", () => {
    for (const level of ["low", "medium", "high", "xhigh"] as const) {
      expect(getReasoningEffort(firstParty, "gpt-6.1-terra", "openai", level, { firstPartyResponses: true })).toBe(level);
    }
    expect(getReasoningEffort(firstParty, "gpt-6.1-terra", "openai", "off", { firstPartyResponses: true })).toBe("none");
    // Never minimal on this route.
    expect(getReasoningEffort(firstParty, "gpt-6.1-terra", "openai", "off", { firstPartyResponses: true })).not.toBe("minimal");
    expect(getReasoningEffort(firstParty, "gpt-6.1-terra", "openai", undefined, { firstPartyResponses: true })).toBe("medium");
  });

  it("off on a non-first-party gpt-5.4+ route sends no effort (byte-identical to main)", () => {
    const gateway = createProvider({ provider: "openai", model: "gpt-6.1-terra", base_url: "https://gateway.example/v1" })("gpt-6.1-terra");
    expect(getReasoningEffort(gateway, "gpt-6.1-terra", "openai")).toBeUndefined();
    expect(getReasoningEffort(gateway, "gpt-6.1-terra", "openai", "off")).toBeUndefined();
    expect(getReasoningEffort(gateway, "gpt-6.1-terra", "openai", "off", { firstPartyResponses: false })).toBeUndefined();
    expect(gateway.reasoning).toBe(false);
  });

  it("the Chat override adds no reasoning effort for gpt-5.4+ ids", () => {
    setUserProviders({ openai: { api: "openai-completions", base_url: "https://api.openai.com/v1", env_key: "OPENAI_API_KEY" } });
    const declared = createProvider({ provider: "openai", model: "gpt-6.1-terra" })("gpt-6.1-terra");
    expect(declared.api).toBe("openai-completions");
    expect(declared.reasoning).toBe(false);
    expect(getReasoningEffort(declared, "gpt-6.1-terra", "openai")).toBeUndefined();
    expect(getReasoningEffort(declared, "gpt-6.1-terra", "openai", "off")).toBeUndefined();
  });

  it("a user-declared provider with a gpt-5.4 id adds no reasoning effort", () => {
    setUserProviders({ custom: { api: "openai-completions", base_url: "https://api.example.com/v1" } });
    const custom = createProvider({ provider: "custom", model: "gpt-5.4" })("gpt-5.4");
    expect(custom.reasoning).toBe(false);
    expect(getReasoningEffort(custom, "gpt-5.4", "custom")).toBeUndefined();
    expect(getReasoningEffort(custom, "gpt-5.4", "custom", "off")).toBeUndefined();
    // Non-reasoning models keep omitting effort even on a first-party route.
    const gpt4o = createProvider({ provider: "openai", model: "gpt-4o" })("gpt-4o");
    expect(getReasoningEffort(gpt4o, "gpt-4o", "openai", "off", { firstPartyResponses: true })).toBeUndefined();
  });
});
