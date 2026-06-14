import { describe, expect, it } from "vitest";
import {
  getProviderConfig,
  getProviderEnvKey,
  getMissingKeyMessage,
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
});
