import { describe, it, expect, beforeEach } from "bun:test";
import {
  getProviderConfig,
  getProviderEnvKey,
  getMissingKeyMessage,
  isProviderAvailable,
  listKnownProviders,
  inferReasoningModel,
} from "../src/llm.js";

describe("llm provider registry", () => {
  it("includes opencode with OpenCode Zen endpoint", () => {
    const pc = getProviderConfig("opencode");
    expect(pc.provider).toBe("opencode");
    expect(pc.api).toBe("openai-completions");
    expect(pc.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(pc.envKey).toBe("OPENCODE_API_KEY");
  });

  it("lists opencode", () => {
    expect(listKnownProviders()).toContain("opencode");
  });

  it("requires OPENCODE_API_KEY for opencode", () => {
    const prev = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    expect(getProviderEnvKey("opencode")).toBe("OPENCODE_API_KEY");
    expect(getMissingKeyMessage("opencode")).toMatch(/OPENCODE_API_KEY/);
    if (prev !== undefined) process.env.OPENCODE_API_KEY = prev;
  });

  it("infers reasoning for kimi model ids", () => {
    expect(inferReasoningModel("openrouter", "kimi-k2.7-code")).toBe(true);
    expect(inferReasoningModel("openrouter", "moonshotai/kimi-k2.5")).toBe(true);
    expect(inferReasoningModel("openrouter", "gpt-4o")).toBe(false);
  });

  it("treats pi-ai providers without configured keys as unavailable", () => {
    const prevMoonshot = process.env.MOONSHOT_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    expect(isProviderAvailable("moonshotai")).toBe(false);
    if (prevMoonshot !== undefined) process.env.MOONSHOT_API_KEY = prevMoonshot;
  });

  it("treats keyless registry providers as available", () => {
    expect(isProviderAvailable("ollama")).toBe(true);
  });
});
