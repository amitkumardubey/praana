import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import { createProvider, setUserProviders } from "../src/llm.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";
import type { StreamRequest } from "../src/llm/types.js";

type RuntimeModel = {
  id: string;
  provider: string;
  baseUrl?: string;
  api?: string;
  compat?: Record<string, unknown>;
  maxTokens?: number;
  __piOptions?: { apiKey?: string };
};

const originalFetch = globalThis.fetch;

/** Run the openai-compatible driver against a fake SSE endpoint and return the JSON body it sent. */
async function sentBody(model: RuntimeModel): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body));
    return new Response("data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;

  const req: StreamRequest = {
    model: model.id,
    provider: model.provider,
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 256,
    baseUrl: model.baseUrl,
    api: model.api,
    compat: model.compat,
    apiKey: model.__piOptions?.apiKey,
  };

  for await (const _event of new OpenAICompatibleDriver().stream(req, {
    apiKey: "sk-test",
  })) {
    // drain
  }

  if (!captured) throw new Error("driver sent no request body");
  return captured;
}

describe("openai-completions max tokens field", () => {
  let praanaHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-maxtokens-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "llm", writeLine: () => {} }));
    setUserProviders(undefined);
  });

  afterEach(() => {
    setUserProviders(undefined);
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
    globalThis.fetch = originalFetch;
  });

  it("sends max_completion_tokens (and not max_tokens) for first-party openai", async () => {
    const model = createProvider({
      provider: "openai",
      model: "gpt-6.1-terra",
    })("gpt-6.1-terra") as RuntimeModel;

    const body = await sentBody(model);
    expect(body.max_completion_tokens).toBe(256);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("keeps max_tokens for gateway providers that set it explicitly (umans, poolside)", async () => {
    for (const [provider, modelId] of [
      ["umans", "umans-coder"],
      ["poolside", "poolside/laguna-s-2.1"],
    ] as const) {
      const model = createProvider({ provider, model: modelId })(
        modelId,
      ) as RuntimeModel;
      const body = await sentBody(model);
      expect(body.max_tokens).toBe(256);
      expect(body).not.toHaveProperty("max_completion_tokens");
    }
  });

  it("keeps max_tokens for a user-declared provider with a custom base URL", async () => {
    setUserProviders({
      "my-gateway": {
        api: "openai-completions",
        base_url: "https://gateway.example.com/v1",
        env_key: "MY_GATEWAY_KEY",
      },
    });

    const model = createProvider({
      provider: "my-gateway",
      model: "gpt-6.1-terra",
    })("gpt-6.1-terra") as RuntimeModel;

    const body = await sentBody(model);
    expect(body.max_tokens).toBe(256);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("keeps max_tokens when provider openai points at a custom base URL", async () => {
    const model = createProvider({
      provider: "openai",
      model: "gpt-6.1-terra",
      base_url: "https://litellm.internal/v1",
    })("gpt-6.1-terra") as RuntimeModel;

    const body = await sentBody(model);
    expect(body.max_tokens).toBe(256);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("keeps max_tokens for the local ollama entry (openai wire, local endpoint)", async () => {
    const model = createProvider({
      provider: "ollama",
      model: "llama3.3",
    })("llama3.3") as RuntimeModel;

    const body = await sentBody(model);
    expect(body.max_tokens).toBe(256);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("lets a model-level compat override win over the provider default", async () => {
    const model = createProvider({
      provider: "openai",
      model: "gpt-6.1-terra",
    })("gpt-6.1-terra") as RuntimeModel;
    model.compat = { ...model.compat, maxTokensField: "max_tokens" };

    const body = await sentBody(model);
    expect(body.max_tokens).toBe(256);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
});
