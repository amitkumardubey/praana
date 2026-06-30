import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import {
  formatActiveModelLabel,
  resolveModelSpecifier,
  resolveModelSpecifierSync,
  catalogHasModel,
  parseModelCommandArgs,
} from "../src/model-resolver.js";
import { resetProviderCatalogCacheForTests } from "../src/provider-catalog.js";

describe("formatActiveModelLabel", () => {
  it("returns model id unchanged when it already has the provider routing prefix", () => {
    expect(formatActiveModelLabel("openrouter", "openrouter/openai/gpt-4o")).toBe(
      "openrouter/openai/gpt-4o",
    );
  });

  it("prefixes bare model ids with provider", () => {
    expect(formatActiveModelLabel("openai", "gpt-4o")).toBe("openai/gpt-4o");
  });

  it("prefixes vendor/model ids routed through another provider", () => {
    expect(formatActiveModelLabel("openrouter", "openai/gpt-4o")).toBe(
      "openrouter/openai/gpt-4o",
    );
  });
});

describe("parseModelCommandArgs", () => {
  beforeEach(() => {
    resetProviderCatalogCacheForTests();
  });
  it("returns help when no model args", () => {
    expect(parseModelCommandArgs(["/model"])).toEqual({ kind: "help" });
  });

  it("parses model-only bare id", () => {
    expect(parseModelCommandArgs(["/model", "gpt-4o"])).toEqual({
      kind: "resolve",
      explicitProvider: null,
      modelSpec: "gpt-4o",
      userInput: "gpt-4o",
    });
  });

  it("parses model-only vendor/model id on current provider", () => {
    expect(parseModelCommandArgs(["/model", "moonshotai/kimi-k2.7-code"])).toEqual({
      kind: "resolve",
      explicitProvider: null,
      modelSpec: "moonshotai/kimi-k2.7-code",
      userInput: "moonshotai/kimi-k2.7-code",
    });
  });

  it("parses explicit provider via space syntax", () => {
    expect(parseModelCommandArgs(["/model", "openai", "gpt-4o"])).toEqual({
      kind: "resolve",
      explicitProvider: "openai",
      modelSpec: "gpt-4o",
      userInput: "openai gpt-4o",
    });
  });

  it("parses explicit openrouter provider with vendor/model id", () => {
    expect(
      parseModelCommandArgs(["/model", "openrouter", "moonshotai/kimi-k2.7-code"]),
    ).toEqual({
      kind: "resolve",
      explicitProvider: "openrouter",
      modelSpec: "moonshotai/kimi-k2.7-code",
      userInput: "openrouter moonshotai/kimi-k2.7-code",
    });
  });

  it("treats slash-containing single arg as model id on current provider", () => {
    expect(parseModelCommandArgs(["/model", "openai/gpt-4o"])).toEqual({
      kind: "resolve",
      explicitProvider: null,
      modelSpec: "openai/gpt-4o",
      userInput: "openai/gpt-4o",
    });
  });

  it("treats openrouter/vendor/model single arg as model id on current provider", () => {
    expect(parseModelCommandArgs(["/model", "openrouter/openai/gpt-4o"])).toEqual({
      kind: "resolve",
      explicitProvider: null,
      modelSpec: "openrouter/openai/gpt-4o",
      userInput: "openrouter/openai/gpt-4o",
    });
  });
});

describe("resolveModelSpecifierSync", () => {
  beforeEach(() => {
    resetProviderCatalogCacheForTests();
  });
  it("resolves native openai model when provider is explicit", () => {
    const result = resolveModelSpecifierSync("gpt-4o", "openrouter", "openai");
    expect(result).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
      switchedProvider: true,
      source: "native-catalog",
      known: true,
    });
  });

  it("resolves native anthropic model when provider is explicit", () => {
    const result = resolveModelSpecifierSync(
      "claude-sonnet-4-20250514",
      "openrouter",
      "anthropic",
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
      known: true,
    });
  });

  it("keeps vendor/model id on current openrouter provider", () => {
    const result = resolveModelSpecifierSync("moonshotai/kimi-k2.5", "openrouter");
    expect(result).toEqual({
      provider: "openrouter",
      modelId: "moonshotai/kimi-k2.5",
      switchedProvider: false,
      source: "model-only",
      known: catalogHasModel("openrouter", "moonshotai/kimi-k2.5"),
    });
  });

  it("resolves native moonshotai when provider is explicit", () => {
    expect(catalogHasModel("moonshotai", "kimi-k2.5")).toBe(true);
    const result = resolveModelSpecifierSync("kimi-k2.5", "openrouter", "moonshotai");
    expect(result.provider).toBe("moonshotai");
    expect(result.modelId).toBe("kimi-k2.5");
    expect(result.source).toBe("native-catalog");
    expect(result.known).toBe(true);
  });

  it("marks unknown vendor/model ids on current openrouter for async catalog lookup", () => {
    const result = resolveModelSpecifierSync(
      "moonshotai/kimi-k2.7-code",
      "openrouter",
    );
    expect(result).toEqual({
      provider: "openrouter",
      modelId: "moonshotai/kimi-k2.7-code",
      switchedProvider: false,
      source: "model-only",
      known: false,
    });
  });

  it("routes explicit openrouter vendor/model without double prefix", () => {
    const result = resolveModelSpecifierSync(
      "moonshotai/kimi-k2.7-code",
      "anthropic",
      "openrouter",
    );
    expect(result).toEqual({
      provider: "openrouter",
      modelId: "moonshotai/kimi-k2.7-code",
      switchedProvider: true,
      source: "provider-fallback",
      known: false,
    });
  });

  it("strips opencode routing prefix on current provider", () => {
    const result = resolveModelSpecifierSync("opencode/mimo-v2.5-free", "opencode");
    expect(result).toEqual({
      provider: "opencode",
      modelId: "mimo-v2.5-free",
      switchedProvider: false,
      source: "model-only",
      known: false,
    });
  });

  it("uses openrouter catalog for explicit openrouter native ids", () => {
    const result = resolveModelSpecifierSync("openai/gpt-4o", "anthropic", "openrouter");
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("openai/gpt-4o");
    expect(result.switchedProvider).toBe(true);
    expect(result.source).toBe("native-catalog");
  });

  it("routes explicit openai instead of openrouter when provider is openai", () => {
    const result = resolveModelSpecifierSync("gpt-4o", "openrouter", "openai");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
    expect(result.source).toBe("native-catalog");
  });
});

describe("resolveModelSpecifier", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetProviderCatalogCacheForTests();
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetProviderCatalogCacheForTests();
  });

  it("accepts OpenCode free models via live catalog when missing from pi-ai", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "mimo-v2.5-free" },
          { id: "nemotron-3-ultra-free" },
          { id: "north-mini-code-free" },
        ],
      }),
    } as Response);

    const result = await resolveModelSpecifier("mimo-v2.5-free", "opencode");
    expect(result).toEqual({
      provider: "opencode",
      modelId: "mimo-v2.5-free",
      switchedProvider: false,
      source: "provider-catalog",
      known: true,
    });
  });
});
