import { describe, it, expect } from "bun:test";
import {
  PROVIDER_REGISTRY,
  formatProviderListForDisplay,
  REASONING_MODEL_HINTS,
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
});
