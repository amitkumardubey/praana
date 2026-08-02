import { describe, it, expect } from "bun:test";
import { providerPageLines, buildProviderSelectItems, CUSTOM_PROVIDER_VALUE } from "../src/setup/provider-options.js";
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
