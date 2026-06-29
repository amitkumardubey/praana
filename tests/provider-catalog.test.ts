import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  findProviderCatalogModelId,
  providerModelIdCandidates,
  PROVIDER_CATALOG_FETCH_TIMEOUT_MS,
  resetProviderCatalogCacheForTests,
  stripProviderRoutingPrefix,
} from "../src/provider-catalog.js";

describe("provider-catalog", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetProviderCatalogCacheForTests();
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetProviderCatalogCacheForTests();
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
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "deepseek-v4-flash-free" },
          { id: "mimo-v2.5-free" },
          { id: "nemotron-3-ultra-free" },
          { id: "north-mini-code-free" },
        ],
      }),
    } as Response);

    await expect(
      findProviderCatalogModelId("opencode", "mimo-v2.5-free"),
    ).resolves.toBe("mimo-v2.5-free");
    await expect(
      findProviderCatalogModelId("opencode", "opencode/nemotron-3-ultra-free"),
    ).resolves.toBe("nemotron-3-ultra-free");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves OpenRouter vendor aliases from the live catalog", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "moonshotai/kimi-k2.7-code", context_length: 262_144 }],
      }),
    } as Response);

    await expect(
      findProviderCatalogModelId("openrouter", "kimi-k2.7-code"),
    ).resolves.toBe("moonshotai/kimi-k2.7-code");
  });

  it("passes an AbortSignal with timeout to catalog fetch", async () => {
    fetchSpy.mockImplementation((_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: [{ id: "mimo-v2.5-free" }] }),
      } as Response);
    });

    await findProviderCatalogModelId("opencode", "mimo-v2.5-free");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("returns null when catalog fetch times out", async () => {
    // Source uses AbortController + setTimeout (not AbortSignal.timeout), so
    // bun's lack of timer advancement doesn't matter. Any fetch rejection
    // reaches findProviderCatalogModelId's catch block which returns null.
    fetchSpy.mockImplementation(() =>
      Promise.reject(
        new Error(
          `Provider catalog fetch timed out after ${PROVIDER_CATALOG_FETCH_TIMEOUT_MS}ms`,
        ),
      ),
    );

    await expect(
      findProviderCatalogModelId("opencode", "mimo-v2.5-free"),
    ).resolves.toBeNull();
  });
});
