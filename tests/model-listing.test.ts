import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { resetProviderCatalogCacheForTests } from "../src/provider-catalog.js";
import {
  buildModelAutocompleteItems,
  filterModelAutocompleteItems,
  listModelsForProvider,
  type ModelListEntry,
} from "../src/model-listing.js";

describe("model-listing", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetProviderCatalogCacheForTests();
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetProviderCatalogCacheForTests();
  });

  it("lists catalog models for a live-catalog provider with context windows", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "openai/gpt-4o", context_length: 128_000 },
          { id: "moonshotai/kimi-k2.7-code", context_length: 262_144 },
        ],
      }),
    } as Response);

    const models = await listModelsForProvider("openrouter");
    expect(models.length).toBeGreaterThanOrEqual(2);
    expect(models.find((m) => m.modelId === "openai/gpt-4o")).toEqual(
      expect.objectContaining({
        provider: "openrouter",
        modelId: "openai/gpt-4o",
        contextWindow: 128_000,
      }),
    );
  });

  it("builds autocomplete items as provider/model with space-separated values", () => {
    const models: ModelListEntry[] = [
      {
        provider: "openai",
        modelId: "gpt-4o",
        label: "gpt-4o",
        contextWindow: 128_000,
        available: true,
      },
      {
        provider: "openrouter",
        modelId: "moonshotai/kimi-k2.7-code",
        label: "moonshotai/kimi-k2.7-code",
        contextWindow: null,
        available: true,
      },
    ];

    const items = buildModelAutocompleteItems(models);
    expect(items).toEqual([
      {
        value: "openai gpt-4o",
        label: "openai/gpt-4o",
        description: "128k ctx",
      },
      {
        value: "openrouter moonshotai/kimi-k2.7-code",
        label: "openrouter/moonshotai/kimi-k2.7-code",
      },
    ]);
  });

  it("fuzzy-filters autocomplete items by provider or model name", () => {
    const catalog = buildModelAutocompleteItems([
      {
        provider: "openai",
        modelId: "gpt-4o",
        label: "gpt-4o",
        contextWindow: 128_000,
        available: true,
      },
      {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        label: "claude-sonnet-4",
        contextWindow: 200_000,
        available: true,
      },
      {
        provider: "openrouter",
        modelId: "openai/gpt-4o-mini",
        label: "openai/gpt-4o-mini",
        contextWindow: 128_000,
        available: true,
      },
    ]);

    const byModel = filterModelAutocompleteItems(catalog, "claude");
    expect(byModel.map((i) => i.label)).toEqual(["anthropic/claude-sonnet-4"]);

    const byProvider = filterModelAutocompleteItems(catalog, "openrouter");
    expect(byProvider.map((i) => i.label)).toEqual([
      "openrouter/openai/gpt-4o-mini",
    ]);

    const byBoth = filterModelAutocompleteItems(catalog, "openai gpt");
    expect(byBoth.length).toBeGreaterThan(0);
    expect(byBoth.every((i) => /openai|gpt/i.test(i.label))).toBe(true);
  });

  it("surfaces live-catalog failures when a provider has no pi-ai models", async () => {
    fetchSpy.mockRejectedValue(new Error("catalog unreachable"));
    // ollama is live-catalog and not in pi-ai, so a failed fetch leaves an empty set.
    await expect(listModelsForProvider("ollama", { available: true })).rejects.toThrow(
      "catalog unreachable",
    );
  });

  it("keeps pi-ai models when live catalog fails", async () => {
    fetchSpy.mockRejectedValue(new Error("catalog unreachable"));
    const models = await listModelsForProvider("openai", { available: true });
    expect(models.length).toBeGreaterThan(0);
  });
});
