import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigWarnings, loadConfig } from "../src/config.js";
import { createProvider } from "../src/llm.js";
import { streamLlmResponse } from "../src/llm/stream.js";
import { resetUserProvidersForTests } from "../src/provider-registry.js";
import type { StreamRequest } from "../src/llm/types.js";

const originalFetch = globalThis.fetch;
let dir = "";
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetUserProvidersForTests();
  getConfigWarnings();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const override = '[providers.openai]\napi = "openai-completions"\nbase_url = "https://api.openai.com/v1"\nenv_key = "OPENAI_API_KEY"\n';

async function checkOverride(toml: string): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "praana-openai-chat-"));
  const path = join(dir, "praana.config.toml");
  writeFileSync(path, '[llm]\nprovider = "openai"\nmodel = "gpt-6.1-terra"\n' + toml);
  getConfigWarnings();
  const config = loadConfig(path);
  expect(getConfigWarnings()).toEqual([]);
  const model = createProvider(config.llm)(config.llm.model!);
  expect(model.api).toBe("openai-completions");
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("data: [DONE]\n\n");
  }) as typeof fetch;
  for await (const _event of streamLlmResponse({
    provider: "openai", model: "gpt-6.1-terra", apiKey: "synthetic-key",
    api: String(model.api), baseUrl: String(model.baseUrl), compat: model.compat as StreamRequest["compat"],
    maxTokens: 128, reasoningEffort: "high", messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "test", description: "Test", parameters: { type: "object" } }],
  })) { /* consume */ }
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
  expect(calls[0]!.body).toMatchObject({ max_completion_tokens: 128, reasoning_effort: "none" });
  expect(calls[0]!.body).not.toHaveProperty("max_tokens");
}

it("supports the existing built-in-id user-provider Chat Completions override end to end", async () => {
  await checkOverride(override);
});

it("runs the documented override verbatim", async () => {
  const doc = readFileSync(join(import.meta.dir, "../docs/reference.md"), "utf8");
  const snippet = /### Force OpenAI Chat Completions[\s\S]*?```toml\n([\s\S]*?)```/.exec(doc)?.[1];
  expect(snippet).toBeDefined();
  await checkOverride(snippet!);
});

it("keeps the commented example override in sync", () => {
  const example = readFileSync(join(import.meta.dir, "../praana.config.example.toml"), "utf8");
  expect(example).toContain(override.trim().split("\n").map((line) => `# ${line}`).join("\n"));
});
