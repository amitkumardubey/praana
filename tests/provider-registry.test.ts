import { describe, it, expect } from "bun:test";
import {
  PROVIDER_REGISTRY,
  formatProviderListForDisplay,
  REASONING_MODEL_HINTS,
  getProviderEnvKey,
  SETUP_UNSUPPORTED_PROVIDERS,
  LIVE_CATALOG_PROVIDER_IDS,
} from "../src/provider-registry.js";

describe("provider registry", () => {
  it("includes umans with the expected env key and base URL", () => {
    const umans = PROVIDER_REGISTRY["umans"];
    expect(umans).toBeDefined();
    expect(umans.provider).toBe("umans");
    expect(umans.envKey).toBe("UMANS_AI_CODING_PLAN_API_KEY");
    expect(umans.baseUrl).toBe("https://api.code.umans.ai/v1");
  });

  it("formatProviderListForDisplay includes umans and pi-ai providers", () => {
    const entries = formatProviderListForDisplay();
    const names = entries.map((e) => e.name);
    expect(names).toContain("umans");
    expect(names).toContain("cerebras");
    expect(names).toContain("ollama");
  });

  it("formatProviderListForDisplay marks ollama and bedrock as local", () => {
    const entries = formatProviderListForDisplay();
    expect(entries.find((e) => e.name === "ollama")?.envKey).toBeNull();
    expect(entries.find((e) => e.name === "amazon-bedrock")?.envKey).toBeNull();
  });

  it("REASONING_MODEL_HINTS flags umans-coder as a reasoning model", () => {
    const umansHints = REASONING_MODEL_HINTS["umans"] ?? [];
    const patterns = umansHints.map((h) => h.pattern.source);
    expect(patterns).toContain("umans-coder");
    expect(patterns).toContain("umans-kimi");
  });

  it("getProviderEnvKey returns the registry env key for known providers", () => {
    expect(getProviderEnvKey("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(getProviderEnvKey("openai")).toBe("OPENAI_API_KEY");
    expect(getProviderEnvKey("umans")).toBe("UMANS_AI_CODING_PLAN_API_KEY");
  });

  it("getProviderEnvKey returns null for keyless providers", () => {
    expect(getProviderEnvKey("ollama")).toBeNull();
    expect(getProviderEnvKey("amazon-bedrock")).toBeNull();
  });

  it("getProviderEnvKey returns the first pi-ai env key for pi-ai-only providers", () => {
    expect(getProviderEnvKey("nvidia")).toBe("NVIDIA_API_KEY");
  });

  it("SETUP_UNSUPPORTED_PROVIDERS hides ollama from setup", () => {
    expect(SETUP_UNSUPPORTED_PROVIDERS.has("ollama")).toBe(true);
    expect(SETUP_UNSUPPORTED_PROVIDERS.has("amazon-bedrock")).toBe(false);
  });

  it("LIVE_CATALOG_PROVIDER_IDS includes umans for OpenAI-compatible /models", () => {
    expect(LIVE_CATALOG_PROVIDER_IDS).toContain("umans");
  });

  it("LIVE_CATALOG_PROVIDER_IDS includes amazon-bedrock", () => {
    expect(LIVE_CATALOG_PROVIDER_IDS).toContain("amazon-bedrock");
  });
});
