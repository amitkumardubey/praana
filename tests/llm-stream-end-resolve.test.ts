import { afterEach, describe, expect, it } from "bun:test";
import {
  STREAM_END_STRICT_PROVIDERS,
  getStreamEndCheck,
  resolveStreamEndMode,
  setStreamEndCheck,
  type StreamEndCheck,
} from "../src/llm/stream-end.js";
import { resetUserProvidersForTests, upsertUserProvider } from "../src/provider-registry.js";

afterEach(() => {
  resetUserProvidersForTests();
  setStreamEndCheck("auto");
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

  it("reads the configured mode when the argument is omitted", () => {
    setStreamEndCheck("lenient");
    expect(getStreamEndCheck()).toBe("lenient");
    expect(resolveStreamEndMode("anthropic")).toBe("lenient");
    setStreamEndCheck("strict");
    expect(resolveStreamEndMode("ollama")).toBe("strict");
  });
});
