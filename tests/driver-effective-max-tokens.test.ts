import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { AzureDriver } from "../src/llm/drivers/azure.js";
import { BedrockDriver } from "../src/llm/drivers/bedrock.js";
import type { LlmDriver } from "../src/llm/drivers/base.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import { OpenAIResponsesDriver } from "../src/llm/drivers/responses.js";
import type { ResolvedAuth, StreamRequest } from "../src/llm/types.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth: ResolvedAuth = {
  apiKey: "fixture-key",
  bearerToken: "fixture-token",
  headers: { "chatgpt-account-id": "fixture-account" },
};

function request(provider: string, extra: Partial<StreamRequest> = {}): StreamRequest {
  return {
    provider,
    model: "fixture-model",
    baseUrl: "https://fixture.invalid",
    region: "us-east-1",
    messages: [{ role: "user", content: "hello" }],
    systemPrompt: "system",
    tools: [],
    ...extra,
  } as StreamRequest;
}

/** Bodies of every request the driver sends; answers each from `statuses`, then 418. */
async function sentBodies(driver: LlmDriver, req: StreamRequest, replies: Array<{ status: number; text: string }> = []): Promise<any[]> {
  const bodies: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    const reply = replies[call++] ?? { status: 418, text: "fixture capture" };
    return new Response(reply.text, { status: reply.status });
  }) as typeof fetch;
  for await (const _ of driver.stream(req, auth)) { /* drain */ }
  return bodies.map((body) => JSON.parse(body));
}

interface Case {
  name: string;
  driver: () => LlmDriver;
  provider: string;
  /** Reads the cap field out of a serialized body (undefined when absent). */
  field: (body: any, req: StreamRequest) => unknown;
  variants: Array<{ label: string; extra: Partial<StreamRequest> }>;
}

const maxTokenVariants = [
  { label: "configured", extra: { maxTokens: 1234 } },
  { label: "unset", extra: {} },
];

const cases: Case[] = [
  {
    name: "anthropic",
    driver: () => new AnthropicDriver(),
    provider: "anthropic",
    field: (body) => body.max_tokens,
    variants: [
      ...maxTokenVariants,
      { label: "budget mode, high", extra: { model: "claude-3-5-sonnet", reasoningEffort: "high", maxTokens: 1000 } },
      { label: "budget mode, medium", extra: { model: "claude-3-5-sonnet", reasoningEffort: "medium", maxTokens: 1000 } },
      { label: "budget mode, low", extra: { model: "claude-3-5-sonnet", reasoningEffort: "low" } },
      { label: "budget mode, minimal", extra: { model: "claude-3-5-sonnet", reasoningEffort: "minimal", maxTokens: 20000 } },
      { label: "budget mode, off", extra: { model: "claude-3-5-sonnet", reasoningEffort: "off", maxTokens: 1000 } },
      { label: "adaptive mode, high", extra: { model: "claude-sonnet-5-5", reasoningEffort: "high", maxTokens: 1000 } },
      { label: "adaptive mode, unset cap", extra: { model: "claude-sonnet-5-5", reasoningEffort: "medium" } },
      { label: "adaptive mode, xhigh", extra: { model: "claude-opus-6-0", reasoningEffort: "xhigh", maxTokens: 50000 } },
    ],
  },
  { name: "bedrock", driver: () => new BedrockDriver(), provider: "bedrock", field: (body) => body.inferenceConfig?.maxTokens, variants: maxTokenVariants },
  { name: "google", driver: () => new GoogleDriver(), provider: "google", field: (body) => body.generationConfig?.maxOutputTokens, variants: maxTokenVariants },
  {
    name: "openai",
    driver: () => new OpenAICompatibleDriver(),
    provider: "openai-compatible",
    field: (body, req) => body[req.compat?.maxTokensField ?? "max_tokens"],
    variants: [
      ...maxTokenVariants,
      { label: "max_completion_tokens field", extra: { maxTokens: 777, compat: { maxTokensField: "max_completion_tokens" } as StreamRequest["compat"] } },
      { label: "with reasoning", extra: { maxTokens: 777, reasoningEffort: "high" } },
    ],
  },
  { name: "azure", driver: () => new AzureDriver(), provider: "azure", field: (body) => body.max_tokens, variants: maxTokenVariants },
  {
    name: "responses",
    driver: () => new OpenAIResponsesDriver(),
    provider: "openai",
    field: (body) => body.max_output_tokens,
    variants: [
      ...maxTokenVariants,
      { label: "codex route, configured", extra: { provider: "openai-codex", maxTokens: 1234 } },
      { label: "codex route, unset", extra: { provider: "openai-codex" } },
      { label: "with reasoning", extra: { maxTokens: 500, reasoningEffort: "medium" } },
    ],
  },
];

describe("driver effective output cap", () => {
  for (const c of cases) {
    for (const v of c.variants) {
      test(`${c.name}: ${v.label} matches the serialized body`, async () => {
        const driver = c.driver();
        const req = request(c.provider, v.extra);
        const expected = driver.effectiveMaxTokens(req);
        const [body] = await sentBodies(driver, req);
        expect(body).toBeDefined();
        const sent = c.field(body, req);
        if (expected === null) expect(sent).toBeUndefined();
        else expect(sent).toBe(expected);
        const upper = driver.effectiveMaxTokensUpperBound(req);
        // Only Anthropic can send a larger cap on a retry; every other driver sends one form.
        if (c.name === "anthropic") expect(upper!).toBeGreaterThanOrEqual(expected!);
        else expect(upper).toBe(expected);
      });
    }
  }

  test("null is returned only where the driver sends no cap", () => {
    expect(new BedrockDriver().effectiveMaxTokens(request("bedrock"))).toBeNull();
    expect(new GoogleDriver().effectiveMaxTokens(request("google"))).toBeNull();
    expect(new OpenAICompatibleDriver().effectiveMaxTokens(request("openai"))).toBeNull();
    expect(new AzureDriver().effectiveMaxTokens(request("azure"))).toBeNull();
    expect(new OpenAIResponsesDriver().effectiveMaxTokens(request("openai"))).toBeNull();
    expect(new OpenAIResponsesDriver().effectiveMaxTokens(request("openai-codex", { maxTokens: 99 }))).toBeNull();
    expect(new AnthropicDriver().effectiveMaxTokens(request("anthropic"))).toBe(8192);
  });
});

describe("anthropic upper bound across the thinking-mode retry", () => {
  test("covers the cap of the retried request, in both directions", async () => {
    const driver = new AnthropicDriver();

    // Model-id default is budget mode; the server rejects it and the driver retries adaptive.
    const budgetFirst = request("anthropic", { model: "claude-retry-budget-first", reasoningEffort: "high", maxTokens: 1000 });
    const first = driver.effectiveMaxTokens(budgetFirst);
    const bodies = await sentBodies(driver, budgetFirst, [{ status: 400, text: "thinking.type.adaptive is required for this model" }]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].max_tokens).toBe(first);
    const upper = driver.effectiveMaxTokensUpperBound(budgetFirst);
    for (const body of bodies) expect(body.max_tokens).toBeLessThanOrEqual(upper);
    expect(upper).toBe(Math.max(...bodies.map((b) => b.max_tokens)));

    // The learned mode is now adaptive for this model: the first attempt follows it.
    const afterLearning = request("anthropic", { model: "claude-retry-budget-first", reasoningEffort: "high", maxTokens: 1000 });
    const [learned] = await sentBodies(driver, afterLearning);
    expect(learned.thinking.type).toBe("adaptive");
    expect(learned.max_tokens).toBe(driver.effectiveMaxTokens(afterLearning));
    expect(driver.effectiveMaxTokensUpperBound(afterLearning)).toBeGreaterThanOrEqual(learned.max_tokens);
  });

  test("an adaptive-first model that retries in budget mode stays under the bound", async () => {
    const driver = new AnthropicDriver();
    const req = request("anthropic", { model: "claude-sonnet-5-retry-adaptive-first", reasoningEffort: "high", maxTokens: 1000 });
    const first = driver.effectiveMaxTokens(req);
    expect(first).toBe(1000);
    const bodies = await sentBodies(driver, req, [{ status: 400, text: "adaptive thinking is not supported for this model" }]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].max_tokens).toBe(1000);
    expect(bodies[1].thinking.type).toBe("enabled");
    expect(bodies[1].max_tokens).toBe(8192 + 4096);
    expect(driver.effectiveMaxTokensUpperBound(req)).toBe(8192 + 4096);
  });

  test("without thinking the bound equals the effective cap", () => {
    const driver = new AnthropicDriver();
    for (const maxTokens of [undefined, 500, 100000]) {
      const req = request("anthropic", { maxTokens });
      expect(driver.effectiveMaxTokensUpperBound(req)).toBe(driver.effectiveMaxTokens(req));
    }
  });
});
