import { describe, it, expect } from "bun:test";
import {
  providerPageLines,
  buildProviderSelectItems,
  CUSTOM_PROVIDER_VALUE,
  findProviderSelectItem,
  providerHintMatchesList,
  resolveProviderHint,
  resolveStoredProviderHint,
  setupProviderIntroLines,
} from "../src/setup/provider-options.js";
import { generateSetupConfigContent, resolveDefaultModel } from "../src/setup/config-writer.js";
import { finalizeProviderSetup } from "../src/setup/logic.js";
import { SETUP_UNSUPPORTED_PROVIDERS } from "../src/provider-registry.js";

describe("providerPageLines", () => {
  it("renders a single page without pagination hint", () => {
    const lines = providerPageLines(["openai", "anthropic"], 0, 10);
    expect(lines).toEqual([
      "  1. openai",
      "  2. anthropic",
      "",
    ]);
  });

  it("renders a full page with pagination hint", () => {
    const providers = Array.from({ length: 12 }, (_, i) => `provider-${i + 1}`);
    const lines = providerPageLines(providers, 0, 10);
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe("  1. provider-1");
    expect(lines[9]).toBe("  10. provider-10");
    expect(lines[10]).toBe("");
    expect(lines[11]).toBe("  Page 1/2. Type 'n' for next, 'p' for previous.");
  });

  it("renders the last partial page", () => {
    const providers = Array.from({ length: 12 }, (_, i) => `provider-${i + 1}`);
    const lines = providerPageLines(providers, 1, 10);
    expect(lines).toEqual([
      "  11. provider-11",
      "  12. provider-12",
      "",
      "  Page 2/2. Type 'n' for next, 'p' for previous.",
    ]);
  });

  it("treats an empty list as one empty page", () => {
    const lines = providerPageLines([], 0, 10);
    expect(lines).toEqual([""]);
  });
});

describe("setupProviderIntroLines", () => {
  it("uses first-run copy when no config and no available providers", () => {
    expect(setupProviderIntroLines(false, [])).toEqual([
      "No provider configured. Let's set one up.",
      "",
      "Choose a provider:",
    ]);
  });

  it("does not claim nothing is configured on a later run", () => {
    expect(
      setupProviderIntroLines(true, ["poolside", "openrouter", "modal-muse"]),
    ).toEqual([
      "Update your provider.",
      "",
      "Already available:",
      "  ✓ poolside",
      "  ✓ openrouter",
      "  ✓ modal-muse",
      "",
      "Choose a provider:",
    ]);
  });

  it("lists already-available providers on first run without the empty-state heading", () => {
    expect(setupProviderIntroLines(false, ["openrouter"])).toEqual([
      "Let's set one up.",
      "",
      "Already available:",
      "  ✓ openrouter",
      "",
      "Choose a provider:",
    ]);
  });
});

describe("buildProviderSelectItems", () => {
  it("excludes setup-unsupported providers", () => {
    const items = buildProviderSelectItems();
    for (const unsupported of SETUP_UNSUPPORTED_PROVIDERS) {
      expect(items.some((i) => i.value === unsupported)).toBe(false);
    }
  });

  it("includes poolside as a Platform API-key provider", () => {
    const items = buildProviderSelectItems();
    const poolside = items.find((i) => i.value === "poolside");
    expect(poolside).toBeDefined();
    expect(poolside!.description).toMatch(/Poolside|POOLSIDE_API_KEY/);
  });

  it("includes env key in description for providers without a detected key", () => {
    const items = buildProviderSelectItems();
    const openrouter = items.find((i) => i.value === "openrouter");
    expect(openrouter).toBeDefined();
    expect(openrouter!.description).toMatch(/OPENROUTER_API_KEY/);
  });

  it("sorts alphabetically within availability groups", () => {
    const items = buildProviderSelectItems().filter(
      (i) => i.value !== CUSTOM_PROVIDER_VALUE,
    );
    const labels = items.map((i) => i.value);
    const sorted = [...labels].sort();
    const available = items.filter((i) => i.description?.startsWith("✓"));
    const unavailable = items.filter((i) => !i.description?.startsWith("✓"));
    expect([...available, ...unavailable].map((i) => i.value)).toEqual(labels);
    expect(available.map((i) => i.value)).toEqual(
      [...available.map((i) => i.value)].sort(),
    );
    expect(unavailable.map((i) => i.value)).toEqual(
      [...unavailable.map((i) => i.value)].sort(),
    );
    expect(sorted.length).toBe(labels.length);
  });

  it("attaches search aliases so common names resolve", () => {
    const items = buildProviderSelectItems();
    const anthropic = items.find((i) => i.value === "anthropic");
    expect(anthropic?.aliases).toContain("claude");
    const bedrock = items.find((i) => i.value === "amazon-bedrock");
    expect(bedrock?.aliases).toContain("bedrock");
  });
});

describe("resolveProviderHint", () => {
  const ids = ["openai", "openai-codex", "anthropic", "amazon-bedrock", "google"];

  it("returns an exact provider id", () => {
    expect(resolveProviderHint("OpenAI", ids)).toBe("openai");
  });

  it("returns a unique alias", () => {
    expect(resolveProviderHint("claude", ids)).toBe("anthropic");
    expect(resolveProviderHint("bedrock", ids)).toBe("amazon-bedrock");
    expect(resolveProviderHint("gemini", ids)).toBe("google");
  });

  it("does not guess when an alias maps to more than one provider", () => {
    expect(resolveProviderHint("chatgpt", ids)).toBeUndefined();
  });
});

describe("findProviderSelectItem", () => {
  const items = buildProviderSelectItems();

  it("matches unique aliases and the custom entry", () => {
    expect(findProviderSelectItem(items, "claude")?.value).toBe("anthropic");
    expect(findProviderSelectItem(items, "custom")?.value).toBe(CUSTOM_PROVIDER_VALUE);
  });

  it("leaves ambiguous aliases unmatched", () => {
    expect(findProviderSelectItem(items, "chatgpt")).toBeUndefined();
  });
});

describe("providerHintMatchesList", () => {
  const items = buildProviderSelectItems();

  it("treats unique aliases and shared aliases as picker hits", () => {
    expect(providerHintMatchesList("claude", items)).toBe(true);
    expect(providerHintMatchesList("chatgpt", items)).toBe(true);
    expect(providerHintMatchesList("open", items)).toBe(true);
  });

  it("does not treat unknown ids as picker hits", () => {
    expect(providerHintMatchesList("local-llm", items)).toBe(false);
  });
});

describe("resolveStoredProviderHint", () => {
  it("resolves a unique alias among stored providers", () => {
    expect(resolveStoredProviderHint("claude", ["openai", "anthropic"])).toEqual({
      providerId: "anthropic",
    });
  });

  it("opens the picker for a shared alias or prefix", () => {
    expect(
      resolveStoredProviderHint("chatgpt", ["openai", "openai-codex"]),
    ).toEqual({ pickerQuery: "chatgpt" });
    expect(
      resolveStoredProviderHint("open", ["openai", "openrouter"]),
    ).toEqual({ pickerQuery: "open" });
  });

  it("returns empty when the name is not among stored providers", () => {
    expect(resolveStoredProviderHint("claude", ["openai"])).toEqual({});
    expect(resolveStoredProviderHint("local-llm", ["openai"])).toEqual({});
  });
});

describe("generateSetupConfigContent", () => {
  it("writes provider and default model", () => {
    const content = generateSetupConfigContent("openrouter", "test/model");
    expect(content).toContain('provider = "openrouter"');
    expect(content).toContain('model = "test/model"');
  });

  it("resolves default model when omitted", () => {
    const model = resolveDefaultModel("openrouter");
    expect(model.length).toBeGreaterThan(0);
    expect(generateSetupConfigContent("openrouter")).toContain(`model = "${model}"`);
  });
});

describe("finalizeProviderSetup", () => {
  it("returns skip message without writing", () => {
    const result = finalizeProviderSetup("openrouter", "skip");
    expect(result.success).toBe(true);
    expect(result.provider).toBe("openrouter");
    expect(result.message.length).toBeGreaterThan(0);
  });
});
