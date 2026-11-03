import { afterEach, describe, expect, it } from "bun:test";
import {
  STREAM_END_STRICT_PROVIDERS,
  isDefaultHostedEndpoint,
  resolveStreamEndMode,
  type StreamEndCheck,
} from "../src/llm/stream-end.js";
import { resetUserProvidersForTests, upsertUserProvider } from "../src/provider-registry.js";

afterEach(() => {
  resetUserProvidersForTests();
});

describe("resolveStreamEndMode", () => {
  const cases: Array<[string, StreamEndCheck, "strict" | "lenient"]> = [
    ["anthropic", "auto", "strict"],
    ["openai", "auto", "strict"],
    ["google", "auto", "strict"],
    ["vertex", "auto", "strict"],
    ["amazon-bedrock", "auto", "strict"],
    ["azure", "auto", "lenient"],
    ["ollama", "auto", "lenient"],
    ["openrouter", "auto", "lenient"],
    ["groq", "auto", "lenient"],
    ["deepseek", "auto", "lenient"],
    ["github-copilot", "auto", "lenient"],
    ["mistral", "auto", "lenient"],
    ["openai-codex", "auto", "lenient"],
    ["lm-studio", "auto", "lenient"],
    ["vllm", "auto", "lenient"],
    ["anthropic", "strict", "strict"],
    ["ollama", "strict", "strict"],
    ["my-llama", "strict", "strict"],
    ["azure", "strict", "strict"],
    ["anthropic", "lenient", "lenient"],
    ["openai", "lenient", "lenient"],
    ["amazon-bedrock", "lenient", "lenient"],
    ["google", "lenient", "lenient"],
    ["vertex", "lenient", "lenient"],
  ];

  for (const [provider, check, expected] of cases) {
    it(`${check} + ${provider} → ${expected}`, () => {
      expect(resolveStreamEndMode(provider, check)).toBe(expected);
    });
  }

  it("lists only the first-party protocols that guarantee a final event", () => {
    expect([...STREAM_END_STRICT_PROVIDERS]).toEqual([
      "anthropic",
      "openai",
      "google",
      "vertex",
      "amazon-bedrock",
    ]);
  });

  it("auto + a user-declared provider → lenient", () => {
    upsertUserProvider("my-llama", {
      api: "openai-completions",
      base_url: "http://127.0.0.1:9/v1",
    });
    expect(resolveStreamEndMode("my-llama", "auto")).toBe("lenient");
  });

  it("auto + a user-declared shadow of a strict id → lenient", () => {
    upsertUserProvider("openai", {
      api: "openai-completions",
      base_url: "http://127.0.0.1:9/v1",
    });
    expect(resolveStreamEndMode("openai", "auto")).toBe("lenient");
  });

  it("strict stays strict for a user-declared provider", () => {
    upsertUserProvider("my-llama", {
      api: "openai-completions",
      base_url: "http://127.0.0.1:9/v1",
    });
    expect(resolveStreamEndMode("my-llama", "strict")).toBe("strict");
  });

  it("treats an omitted check as auto", () => {
    expect(resolveStreamEndMode("anthropic")).toBe("strict");
    expect(resolveStreamEndMode("ollama")).toBe("lenient");
  });

  it("treats a hosted id on another host as lenient under auto", () => {
    expect(isDefaultHostedEndpoint("openai", "http://localhost:11434/v1")).toBe(false);
    expect(resolveStreamEndMode("openai", "auto", "http://localhost:11434/v1")).toBe("lenient");
    expect(resolveStreamEndMode("openai", "strict", "http://127.0.0.1:11434/v1")).toBe("strict");
  });

  it("keeps the built-in OpenAI host strict under auto", () => {
    expect(isDefaultHostedEndpoint("openai")).toBe(true);
    expect(isDefaultHostedEndpoint("openai", "https://api.openai.com/v1")).toBe(true);
    expect(resolveStreamEndMode("openai", "auto")).toBe("strict");
    expect(resolveStreamEndMode("openai", "auto", "https://api.openai.com/v1")).toBe("strict");
  });
});
