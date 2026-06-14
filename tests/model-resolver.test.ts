import { describe, expect, it } from "vitest";
import {
  resolveModelSpecifierSync,
  catalogHasModel,
} from "../src/model-resolver.js";

describe("resolveModelSpecifierSync", () => {
  it("resolves native openai model from catalog", () => {
    const result = resolveModelSpecifierSync("openai/gpt-4o", "openrouter");
    expect(result).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
      switchedProvider: true,
      source: "native-catalog",
    });
  });

  it("resolves native anthropic model from catalog", () => {
    const result = resolveModelSpecifierSync(
      "anthropic/claude-sonnet-4-20250514",
      "openrouter",
    );
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-20250514");
    expect(result.switchedProvider).toBe(true);
    expect(result.source).toBe("native-catalog");
  });

  it("keeps bare model on current provider", () => {
    const result = resolveModelSpecifierSync("gpt-4o", "openai");
    expect(result).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
      switchedProvider: false,
      source: "model-only",
    });
  });

  it("resolves native moonshotai when catalog has the model", () => {
    expect(catalogHasModel("moonshotai", "kimi-k2.5")).toBe(true);
    const result = resolveModelSpecifierSync("moonshotai/kimi-k2.5", "openrouter");
    expect(result.provider).toBe("moonshotai");
    expect(result.modelId).toBe("kimi-k2.5");
    expect(result.source).toBe("native-catalog");
  });

  it("falls back to openrouter for unknown moonshotai model ids", () => {
    const result = resolveModelSpecifierSync(
      "moonshotai/kimi-k2.7-code",
      "openrouter",
    );
    expect(result).toEqual({
      provider: "openrouter",
      modelId: "moonshotai/kimi-k2.7-code",
      switchedProvider: false,
      source: "openrouter-fallback",
    });
  });

  it("routes openrouter/moonshotai/kimi-k2.7-code without double prefix", () => {
    const result = resolveModelSpecifierSync(
      "openrouter/moonshotai/kimi-k2.7-code",
      "anthropic",
    );
    expect(result).toEqual({
      provider: "openrouter",
      modelId: "moonshotai/kimi-k2.7-code",
      switchedProvider: true,
      source: "openrouter-fallback",
    });
  });

  it("uses openrouter catalog for routed vendor/model ids", () => {
    const result = resolveModelSpecifierSync("openrouter/openai/gpt-4o", "anthropic");
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("openai/gpt-4o");
    expect(result.switchedProvider).toBe(true);
    expect(result.source).toBe("native-catalog");
  });

  it("routes openai/gpt-4o to native openai instead of openrouter", () => {
    const result = resolveModelSpecifierSync("openai/gpt-4o", "openrouter");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
    expect(result.source).toBe("native-catalog");
  });
});
