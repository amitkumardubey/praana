import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildProviderSelectItems,
  CUSTOM_PROVIDER_VALUE,
} from "../src/setup/provider-options.js";
import { resetCredentialStoreForTests } from "../src/credentials.js";
import { resetUserProvidersForTests } from "../src/provider-registry.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";
import { providerEnvKeyNames } from "./helpers/provider-env-keys.js";

const POPULAR = ["openai", "anthropic", "google", "openrouter", "deepseek", "groq", "mistral"];

/** All setup-visible providers minus the popular group, in alphabetical order. */
const REST_ALPHA = [
  "amazon-bedrock",
  "cerebras",
  "fireworks",
  "github-copilot",
  "nvidia",
  "openai-codex",
  "opencode",
  "poolside",
  "together",
  "umans",
  "xai",
];

describe("buildProviderSelectItems ordering", () => {
  let praanaHome: string;
  let prevHome: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-provider-order-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "app", writeLine: () => {} }));
    resetCredentialStoreForTests();
    resetUserProvidersForTests();
    for (const k of providerEnvKeyNames()) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    resetUserProvidersForTests();
    for (const k of providerEnvKeyNames()) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  it("keeps the 'Already available' detection summary intact", () => {
    // The wizard prints an availability summary separately from the picker;
    // the picker must still rank available providers first.
    process.env.GROQ_API_KEY = "sk-groq-test";
    process.env.MISTRAL_API_KEY = "sk-mistral-test";
    const items = buildProviderSelectItems();
    expect(items.map((i) => i.value).slice(0, 2)).toEqual(["groq", "mistral"]);
  });

  it("orders: available first, then popular hosted group, then the rest alphabetically, custom last", () => {
    process.env.GROQ_API_KEY = "sk-groq-test";
    process.env.MISTRAL_API_KEY = "sk-mistral-test";
    const items = buildProviderSelectItems();
    const values = items.map((i) => i.value);
    const popularRemaining = POPULAR.filter((p) => !["groq", "mistral"].includes(p));
    expect(values).toEqual([
      "groq",
      "mistral",
      ...popularRemaining,
      ...REST_ALPHA,
      CUSTOM_PROVIDER_VALUE,
    ]);
  });

  it("without available providers: starts with the popular hosted group in fixed order, then the rest alphabetically, custom last", () => {
    const items = buildProviderSelectItems();
    const values = items.map((i) => i.value);
    expect(values).toEqual([...POPULAR, ...REST_ALPHA, CUSTOM_PROVIDER_VALUE]);
  });

  it("an available provider stays first even when it is also in the popular group", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const items = buildProviderSelectItems();
    const values = items.map((i) => i.value);
    expect(values[0]).toBe("openai");
    expect(values.slice(1, 7)).toEqual(POPULAR.filter((p) => p !== "openai"));
    expect(values[values.length - 1]).toBe(CUSTOM_PROVIDER_VALUE);
  });

  it("custom endpoint is last with the local/self-hosted description", () => {
    const items = buildProviderSelectItems();
    const last = items[items.length - 1];
    expect(last.value).toBe(CUSTOM_PROVIDER_VALUE);
    expect(last.description).toBe(
      "Local or self-hosted server (Ollama, LM Studio, vLLM, llama.cpp)",
    );
  });

  it("searching still finds the custom endpoint by alias", async () => {
    const { findProviderSelectItem } = await import("../src/setup/provider-options.js");
    const {
      filterPickerOptions,
      toPaletteOptions,
    } = await import("../src/ui/tui/overlays/picker-items.js");
    const items = buildProviderSelectItems();
    const palette = toPaletteOptions(items);
    // Exact-name resolution (readline fallback) still hits the custom entry.
    expect(findProviderSelectItem(items, "custom")?.value).toBe(CUSTOM_PROVIDER_VALUE);
    // The wizard picker search matches aliases, so typing ollama/vllm still
    // surfaces the custom endpoint even though it sits at the end of the list.
    const hits = filterPickerOptions(palette, "ollama").map((o) => o.value);
    expect(hits).toContain(CUSTOM_PROVIDER_VALUE);
    const vllmHits = filterPickerOptions(palette, "vllm").map((o) => o.value);
    expect(vllmHits).toContain(CUSTOM_PROVIDER_VALUE);
  });
});
