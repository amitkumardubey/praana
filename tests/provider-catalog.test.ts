import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findProviderCatalogModelId,
  providerModelIdCandidates,
  resetProviderCatalogCacheForTests,
  stripProviderRoutingPrefix,
} from "../src/provider-catalog.js";

describe("provider-catalog", () => {
  beforeEach(() => {
    resetProviderCatalogCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips provider routing prefixes", () => {
    expect(stripProviderRoutingPrefix("opencode", "opencode/mimo-v2.5-free")).toBe(
      "mimo-v2.5-free",
    );
    expect(stripProviderRoutingPrefix("openrouter", "openrouter/openai/gpt-4o")).toBe(
      "openai/gpt-4o",
    );
  });

  it("adds moonshotai vendor prefix candidates for bare kimi model ids on openrouter", () => {
    expect(providerModelIdCandidates("openrouter", "kimi-k2.7-code")).toEqual([
      "kimi-k2.7-code",
      "moonshotai/kimi-k2.7-code",
    ]);
  });

  it("resolves OpenCode free models from the live catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { id: "deepseek-v4-flash-free" },
            { id: "mimo-v2.5-free" },
            { id: "nemotron-3-ultra-free" },
            { id: "north-mini-code-free" },
          ],
        }),
      })),
    );

    await expect(
      findProviderCatalogModelId("opencode", "mimo-v2.5-free"),
    ).resolves.toBe("mimo-v2.5-free");
    await expect(
      findProviderCatalogModelId("opencode", "opencode/nemotron-3-ultra-free"),
    ).resolves.toBe("nemotron-3-ultra-free");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("resolves OpenRouter vendor aliases from the live catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [{ id: "moonshotai/kimi-k2.7-code", context_length: 262_144 }],
        }),
      })),
    );

    await expect(
      findProviderCatalogModelId("openrouter", "kimi-k2.7-code"),
    ).resolves.toBe("moonshotai/kimi-k2.7-code");
  });
});
