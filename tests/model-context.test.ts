import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  lookupPiAiContextWindow,
  resolveContextWindowSync,
  fetchAndCacheContextWindow,
  resetModelContextCacheForTests,
} from "../src/model-context.js";

describe("model-context", () => {
  beforeEach(() => {
    resetModelContextCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("falls back to default for unknown models", () => {
    expect(resolveContextWindowSync("openrouter", "totally/unknown-model-xyz")).toBe(
      128_000,
    );
  });

  it("caches fetched context windows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [{ id: "vendor/custom-model", context_length: 96_000 }],
        }),
      })),
    );

    const first = await fetchAndCacheContextWindow("openrouter", "vendor/custom-model");
    const second = await fetchAndCacheContextWindow("openrouter", "vendor/custom-model");

    expect(first).toBe(96_000);
    expect(second).toBe(96_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      resolveContextWindowSync("openrouter", "vendor/custom-model"),
    ).toBe(96_000);
  });
});
