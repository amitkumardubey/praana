import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resetProviderCatalogCacheForTests } from "../src/provider-catalog.js";
import {
  buildModelAutocompleteItems,
  filterModelAutocompleteItems,
  formatModelsCliOutput,
  listAllAvailableModels,
  listModelsForCli,
  listModelsForProvider,
  resolveCliProviderFilter,
  type ModelListEntry,
} from "../src/model-listing.js";
import { getCuratedModels } from "../src/llm/catalog.js";
import { DEFAULT_MODELS } from "../src/llm.js";
import { pickDefaultModel } from "../src/setup/logic.js";
import { resolveModelSpecifier } from "../src/model-resolver.js";
import { resetCredentialStoreForTests, setOAuthToken } from "../src/credentials.js";

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

const CODEX_MODELS: Array<[id: string, contextWindow: number]> = [
  ["gpt-6.1-sol", 500_000],
  ["gpt-6-astra", 272_000],
  ["gpt-6.1-terra", 500_000],
  ["gpt-6-sol", 272_000],
  ["gpt-6-luna", 272_000],
  ["gpt-5.6-sol", 272_000],
  ["gpt-5.6-terra", 272_000],
  ["gpt-5.6-luna", 272_000],
];

describe("openai-codex model catalog", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    resetProviderCatalogCacheForTests();
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockRejectedValue(new Error("no network in catalog tests"));
    const scratch = join(homedir(), ".cache/codex-fix2-scratch");
    mkdirSync(scratch, { recursive: true });
    home = mkdtempSync(join(scratch, "codex-models-"));
    previousHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = home;
    resetCredentialStoreForTests();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetCredentialStoreForTests();
    resetProviderCatalogCacheForTests();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previousHome;
  });

  it("lists the eight Codex models when authenticated and none when not", async () => {
    const signedOut = (await listAllAvailableModels()).filter((model) => model.provider === "openai-codex");
    expect(signedOut).toEqual([]);

    setOAuthToken("openai-codex", {
      access: "codex-access",
      refresh: "codex-refresh",
      expires: Date.now() + 3_600_000,
    });
    const signedIn = (await listAllAvailableModels())
      .filter((model) => model.provider === "openai-codex")
      .sort((a, b) => a.modelId.localeCompare(b.modelId));
    expect(signedIn.map((model) => model.modelId)).toEqual(
      CODEX_MODELS.map(([id]) => id).sort((a, b) => a.localeCompare(b)),
    );
    for (const [id, contextWindow] of CODEX_MODELS) {
      expect(signedIn.find((model) => model.modelId === id)).toEqual(
        expect.objectContaining({ provider: "openai-codex", contextWindow, available: true }),
      );
    }
    expect(signedIn.some((model) => model.modelId === "gpt-reserve" || model.modelId === "codex-auto-review")).toBe(false);

    const curated = getCuratedModels("openai-codex");
    expect(curated.map((model) => model.id)).toEqual(CODEX_MODELS.map(([id]) => id));
    expect(curated.every((model) => model.reasoning === true)).toBe(true);
    expect(DEFAULT_MODELS["openai-codex"]).toBe("gpt-6.1-sol");
    expect(CODEX_MODELS.map(([id]) => id)).toContain(DEFAULT_MODELS["openai-codex"]);
    expect(pickDefaultModel("openai-codex")).toBe("gpt-6.1-sol");
  });

  it("rejects bare gpt-5.6 and accepts a listed Codex id", async () => {
    const unknown = await resolveModelSpecifier("gpt-5.6", "openai", "openai-codex");
    expect(unknown).toMatchObject({ provider: "openai-codex", modelId: "gpt-5.6", known: false, source: "model-only" });
    const known = await resolveModelSpecifier("gpt-6.1-sol", "openai", "openai-codex");
    expect(known).toMatchObject({ provider: "openai-codex", modelId: "gpt-6.1-sol", known: true, source: "native-catalog" });
  });
});
