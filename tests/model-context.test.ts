import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  lookupPiAiContextWindow,
  resolveContextWindowSync,
  fetchAndCacheContextWindow,
  resetModelContextCacheForTests,
  openRouterModelIdCandidates,
} from "../src/model-context.js";

describe("model-context", () => {
  beforeEach(() => {
    resetModelContextCacheForTests();
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  it("looks up context window from pi-ai catalog", () => {
    expect(lookupPiAiContextWindow("openrouter", "deepseek/deepseek-v4-flash")).toBe(
      1_048_576,
    );
    expect(lookupPiAiContextWindow("anthropic", "claude-sonnet-4-20250514")).toBe(
      200_000,
    );
  });

  it("uses config override when provided", () => {
    expect(resolveContextWindowSync("openrouter", "unknown/model", 32_000)).toBe(
      32_000,
    );
  });

  it("caches the default fallback for unknown models", async () => {
    expect(resolveContextWindowSync("openrouter", "totally/unknown-model-xyz")).toBe(
      128_000,
    );
    const fetched = await fetchAndCacheContextWindow(
      "openrouter",
      "totally/unknown-model-xyz",
    );
    expect(fetched).toBe(128_000);
    // Verify the default was cached — subsequent sync lookups should not
    // re-traverse all lookup paths.
    expect(resolveContextWindowSync("openrouter", "totally/unknown-model-xyz")).toBe(
      128_000,
    );
  });

  it("adds moonshotai vendor prefix candidates for bare kimi model ids", () => {
    expect(openRouterModelIdCandidates("kimi-k2.7-code")).toEqual([
      "kimi-k2.7-code",
      "moonshotai/kimi-k2.7-code",
    ]);
  });

  it("resolves context window via vendor prefix alias in OpenRouter catalog", async () => {
    spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "moonshotai/kimi-k2.7-code", context_length: 262_144 }],
      }),
    } as Response));

    const window = await fetchAndCacheContextWindow("openrouter", "kimi-k2.7-code");
    expect(window).toBe(262_144);
  });

  it("caches fetched context windows", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "vendor/custom-model", context_length: 96_000 }],
      }),
    } as Response));

    const first = await fetchAndCacheContextWindow("openrouter", "vendor/custom-model");
    const second = await fetchAndCacheContextWindow("openrouter", "vendor/custom-model");

    expect(first).toBe(96_000);
    expect(second).toBe(96_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(resolveContextWindowSync("openrouter", "vendor/custom-model")).toBe(96_000);
  });
});
