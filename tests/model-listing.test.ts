import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { resetProviderCatalogCacheForTests } from "../src/provider-catalog.js";
import {
  buildModelAutocompleteItems,
  filterModelAutocompleteItems,
  formatModelsCliOutput,
  listAllAvailableModels,
  listModelsForCli,
  listModelsForProvider,
  listStaticAvailableModels,
  resolveCliProviderFilter,
  type ModelListEntry,
} from "../src/model-listing.js";
import { listKnownProviders, isProviderAvailable } from "../src/llm.js";
import { getCuratedModels } from "../src/llm/catalog.js";
import { PROVIDER_REGISTRY } from "../src/provider-registry.js";

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

  it("surfaces live-catalog failures when a provider has no curated models", async () => {
    fetchSpy.mockRejectedValue(new Error("catalog unreachable"));
    await expect(listModelsForProvider("cerebras", { available: true })).rejects.toThrow(
      "catalog unreachable",
    );
  });

  it("keeps pi-ai models when live catalog fails", async () => {
    fetchSpy.mockRejectedValue(new Error("catalog unreachable"));
    const models = await listModelsForProvider("openai", { available: true });
    expect(models.length).toBeGreaterThan(0);
  });
});

describe("formatModelsCliOutput", () => {
  it("groups by provider and shows availability and default marker", () => {
    const output = formatModelsCliOutput(
      [
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
          available: false,
          disabledReason: "ANTHROPIC_API_KEY is not set",
        },
        {
          provider: "openai",
          modelId: "gpt-4o-mini",
          label: "gpt-4o-mini",
          contextWindow: null,
          available: true,
        },
      ],
      { defaultProvider: "openai", defaultModel: "gpt-4o" },
    );

    expect(output).toContain("anthropic (unavailable: ANTHROPIC_API_KEY is not set)");
    expect(output).toContain("openai");
    expect(output).not.toContain("(available)");
    expect(output).toContain("  claude-sonnet-4");
    expect(output).toContain("  gpt-4o *");
    expect(output).toContain("  gpt-4o-mini");
    expect(output).not.toContain("ctx");
    // Providers sorted alphabetically: anthropic before openai
    expect(output.indexOf("anthropic")).toBeLessThan(output.indexOf("openai"));
  });

  it("shows empty-catalog placeholder for provider-only failure rows", () => {
    const output = formatModelsCliOutput([
      {
        provider: "ollama",
        modelId: "",
        label: "",
        contextWindow: null,
        available: false,
        disabledReason: "catalog unreachable",
      },
    ]);
    expect(output).toContain("ollama (unavailable: catalog unreachable)");
    expect(output).toContain("  (no models in catalog)");
  });

  it("returns a clear message when there are no entries", () => {
    expect(formatModelsCliOutput([])).toBe("No models found.");
  });
});

describe("listModelsForCli", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetProviderCatalogCacheForTests();
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetProviderCatalogCacheForTests();
  });

  it("resolves provider filter case-insensitively", () => {
    expect(resolveCliProviderFilter("OpenRouter")).toBe("openrouter");
  });

  it("rejects unknown provider filters", () => {
    expect(() => resolveCliProviderFilter("not-a-real-provider")).toThrow(
      /Unknown provider/,
    );
  });

  it("filters CLI listing to one provider", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "openai/gpt-4o", context_length: 128_000 }] }),
    } as Response);

    const models = await listModelsForCli("openrouter");
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "openrouter")).toBe(true);
  });

  it("rejects unknown provider in listModelsForCli", async () => {
    await expect(listModelsForCli("not-a-real-provider")).rejects.toThrow(
      /Unknown provider/,
    );
  });

  it("defaults to configured providers only", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    const models = await listModelsForCli();
    // Without --all, every returned provider must be marked available.
    expect(models.every((m) => m.available)).toBe(true);
  });

  it("includeUnavailable lists providers without API keys", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "openai/gpt-4o", context_length: 128_000 }] }),
    } as Response);

    const models = await listModelsForCli(undefined, { includeUnavailable: true });
    expect(models.some((m) => !m.available)).toBe(true);
  });
});

describe("listAllAvailableModels (parallel, static-first)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const ENV_KEYS = [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "FIREWORKS_API_KEY",
    "TOGETHER_API_KEY",
    "CEREBRAS_API_KEY",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OPENAI_API_KEY = "sk-test-openai";
    process.env.OPENROUTER_API_KEY = "sk-test-openrouter";
    process.env.DEEPSEEK_API_KEY = "sk-test-deepseek";
    resetProviderCatalogCacheForTests();
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetProviderCatalogCacheForTests();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const okJson = (data: Array<{ id: string; context_length?: number }>) =>
    ({ ok: true, status: 200, json: async () => ({ data }) }) as unknown as Response;

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const providerDelayFor = (url: string): number => {
    if (url.includes("api.openai.com")) return 200;
    if (url.includes("openrouter.ai")) return 300;
    if (url.includes("api.deepseek.com")) return 250;
    return 0;
  };

  it("queries providers in parallel: total time ≈ max latency, not the sum", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      await delay(providerDelayFor(url));
      return okJson([]);
    });

    const start = Date.now();
    const models = await listAllAvailableModels();
    const elapsed = Date.now() - start;

    // Serial would be 200+300+250 ≈ 750ms+; parallel ≈ 300ms.
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(600);
    expect(models.length).toBeGreaterThan(0);
  });

  it("listStaticAvailableModels is synchronous and performs no network I/O", () => {
    const models = listStaticAvailableModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.available)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("merged result equals the old sequential output (order and content)", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      await delay(providerDelayFor(url));
      if (url.includes("api.openai.com")) {
        return okJson([{ id: "gpt-4o", context_length: 128_000 }, { id: "gpt-5", context_length: 262_144 }]);
      }
      if (url.includes("openrouter.ai")) {
        return okJson([{ id: "openai/gpt-4o-mini", context_length: 128_000 }, { id: "openrouter/only-live", context_length: 327_68 }]);
      }
      return okJson([]);
    });

    // Reference: the old sequential implementation.
    const providers = listKnownProviders().filter((p) => isProviderAvailable(p));
    const expected: ModelListEntry[] = [];
    for (const provider of providers) {
      try {
        expected.push(...(await listModelsForProvider(provider, { available: true })));
      } catch {
        // old behaviour: collect and continue
      }
    }

    const updates: ModelListEntry[][] = [];
    const metas: Array<{ pending: number; failed: string[] }> = [];
    const result = await listAllAvailableModels({
      onUpdate: (entries, meta) => {
        updates.push(entries);
        metas.push({ pending: meta.pending, failed: meta.failed });
      },
    });

    expect(result).toEqual(expected);
    // First update is delivered synchronously before any provider settles.
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(metas[0].pending).toBe(providers.length);
    expect(updates[updates.length - 1]).toEqual(result);
  });

  it("one provider failing does not drop the other providers' models, and the failure is reported", async () => {
    // A provider whose live fetch fails only surfaces as a per-provider error
    // when it has no curated models to fall back on (same as the old
    // sequential code). Find one among the available providers; if the
    // environment has none, the cross-provider assertions below still hold.
    const failProvider = listKnownProviders().find(
      (p) => isProviderAvailable(p) && getCuratedModels(p).length === 0,
    );

    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      await delay(providerDelayFor(url));
      if (failProvider && url.includes(new URL(PROVIDER_REGISTRY[failProvider].baseUrl).host)) {
        throw new Error(`${failProvider} catalog unreachable`);
      }
      return okJson([{ id: "shared/live-model", context_length: 64_000 }]);
    });

    const failures: string[] = [];
    const result = await listAllAvailableModels({
      onUpdate: (_entries, meta) => {
        failures.push(...meta.failed);
      },
    });

    // Other providers' live results are merged in…
    expect(result.some((m) => m.modelId === "shared/live-model")).toBe(true);
    if (failProvider) {
      // …the failing provider contributes nothing (no curated models to
      // keep), and the failure is reported to the UI.
      expect(result.some((m) => m.provider === failProvider)).toBe(false);
      expect(failures.some((f) => f.includes(failProvider))).toBe(true);
    }
  });

  it("static snapshot order is stable and sorted per provider even when every live fetch fails", async () => {
    // Groq's curated catalog is deliberately unsorted (deepseek-r1… before
    // llama-3.3…), so it proves static ordering is applied, not inherited.
    process.env.GROQ_API_KEY = "sk-test-groq";
    fetchSpy.mockRejectedValue(new Error("catalog unreachable"));
    const updates: ModelListEntry[][] = [];
    const result = await listAllAvailableModels({
      onUpdate: (entries) => {
        updates.push(entries);
      },
    });

    // The first emit is the purely static snapshot; with every live fetch
    // failing it must equal the final result — order never depends on live
    // success.
    expect(updates[0]).toEqual(result);

    // Each provider's slice is sorted by modelId.
    for (const provider of new Set(result.map((e) => e.provider))) {
      const ids = result.filter((e) => e.provider === provider).map((e) => e.modelId);
      expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
    }

    // The failing-live result matches listStaticAvailableModels per provider.
    const staticByProvider = new Map<string, ModelListEntry[]>();
    for (const e of listStaticAvailableModels()) {
      const list = staticByProvider.get(e.provider) ?? [];
      list.push(e);
      staticByProvider.set(e.provider, list);
    }
    for (const [provider, staticSlice] of staticByProvider) {
      expect(result.filter((e) => e.provider === provider)).toEqual(staticSlice);
    }
  });

  it("reports live-catalog failures for curated providers without dropping their models, sorted by provider id", async () => {
    process.env.GROQ_API_KEY = "sk-test-groq";
    fetchSpy.mockRejectedValue(new Error("catalog unreachable"));
    const metas: Array<{ pending: number; failed: string[] }> = [];
    const result = await listAllAvailableModels({
      onUpdate: (_entries, meta) => {
        metas.push({ pending: meta.pending, failed: [...meta.failed] });
      },
    });

    // Curated models survive the live failures.
    expect(result.length).toBeGreaterThan(0);
    const curatedProviders = listKnownProviders().filter(
      (p) => isProviderAvailable(p) && getCuratedModels(p).length > 0,
    );
    for (const p of curatedProviders) {
      expect(result.some((m) => m.provider === p)).toBe(true);
    }

    // Every curated provider's live failure is reported as `provider: message`.
    const finalFailed = metas[metas.length - 1].failed;
    expect(finalFailed.length).toBeGreaterThan(0);
    for (const p of curatedProviders) {
      expect(finalFailed).toContain(`${p}: catalog unreachable`);
    }

    // Deterministic order: sorted by provider id at every emit.
    for (const meta of metas) {
      expect(meta.failed).toEqual(
        [...meta.failed].sort((a, b) => a.localeCompare(b)),
      );
    }
  });

  it("failed order is stable regardless of completion order", async () => {
    process.env.GROQ_API_KEY = "sk-test-groq";
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      // openai fails late, groq fails early: completion order is the
      // reverse of provider-id order.
      if (url.includes("api.openai.com")) await delay(120);
      throw new Error("catalog unreachable");
    });
    const failedSeen: string[][] = [];
    await listAllAvailableModels({
      onUpdate: (_entries, meta) => {
        failedSeen.push([...meta.failed]);
      },
    });
    expect(failedSeen.length).toBeGreaterThan(0);
    for (const f of failedSeen) {
      expect(f).toEqual([...f].sort((a, b) => a.localeCompare(b)));
    }
    const last = failedSeen[failedSeen.length - 1];
    const ids = last.map((f) => f.split(":")[0]);
    expect(ids).toEqual([...ids].sort());
  });

  it("listStaticAvailableModels is sorted by modelId within each provider", () => {
    process.env.GROQ_API_KEY = "sk-test-groq";
    const byProvider = new Map<string, ModelListEntry[]>();
    for (const e of listStaticAvailableModels()) {
      const list = byProvider.get(e.provider) ?? [];
      list.push(e);
      byProvider.set(e.provider, list);
    }
    for (const [, list] of byProvider) {
      const ids = list.map((e) => e.modelId);
      expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
    }
  });
});
