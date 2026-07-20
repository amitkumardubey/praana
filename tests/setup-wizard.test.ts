import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateSetupConfigContent,
  writeProviderConfig,
  getSetupConfigPath,
  escapeTomlString,
} from "../src/setup/config-writer.js";
import {
  saveProviderKey,
  fetchProviderModels,
  fetchCustomProviderModels,
  pickDefaultModel,
  finalizeProviderSetup,
  isValidCustomProviderId,
  isValidBaseUrl,
  providerRequiresApiKey,
  getEnvApiKeyForProvider,
  formatEnvKeyOfferMessage,
  adoptEnvKeyForProvider,
  tryAutoSelectProvider,
} from "../src/setup/logic.js";
import {
  buildProviderSelectItems,
  CUSTOM_PROVIDER_VALUE,
} from "../src/setup/provider-options.js";
import {
  getApiKey,
  hasApiKey,
  setApiKey,
  resetCredentialStoreForTests,
} from "../src/credentials.js";
import { resetUserProvidersForTests, setUserProviders } from "../src/provider-registry.js";
import {
  fetchModelsFromEndpoint,
  resetProviderCatalogCacheForTests,
} from "../src/provider-catalog.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";
import { DEFAULT_MODELS } from "../src/llm.js";

describe("setup wizard", () => {
  let praanaHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-setup-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "app", writeLine: () => {} }));
    resetCredentialStoreForTests();
    resetUserProvidersForTests();
    resetProviderCatalogCacheForTests();
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    resetUserProvidersForTests();
    resetProviderCatalogCacheForTests();
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  // ── config-writer: generateSetupConfigContent ──

  describe("generateSetupConfigContent", () => {
    it("does not include # export KEY=... comment line", () => {
      const content = generateSetupConfigContent(
        "openrouter",
        "deepseek/deepseek-v4-flash:free",
      );
      expect(content).not.toContain("# export");
      expect(content).not.toContain("export ");
    });

    it("includes provider and model lines", () => {
      const content = generateSetupConfigContent(
        "openrouter",
        "deepseek/deepseek-v4-flash:free",
      );
      expect(content).toContain('provider = "openrouter"');
      expect(content).toContain('model = "deepseek/deepseek-v4-flash:free"');
    });

    it("includes [providers.<id>] section when customProvider is provided", () => {
      const content = generateSetupConfigContent("my-llama", "llama-3.1-8b", {
        id: "my-llama",
        api: "openai-completions",
        baseUrl: "http://localhost:8080/v1",
      });
      expect(content).toContain("[providers.my-llama]");
      expect(content).toContain('api = "openai-completions"');
      expect(content).toContain('base_url = "http://localhost:8080/v1"');
      // No env_key when key is in credential store
      expect(content).not.toContain("env_key");
    });

    it("includes env_key when provided", () => {
      const content = generateSetupConfigContent("my-llama", "llama-3.1-8b", {
        id: "my-llama",
        api: "openai-completions",
        baseUrl: "http://localhost:8080/v1",
        envKey: "MY_LLAMA_KEY",
      });
      expect(content).toContain('env_key = "MY_LLAMA_KEY"');
    });

    it("does not include 'restart' message", () => {
      const content = generateSetupConfigContent("openrouter");
      expect(content.toLowerCase()).not.toContain("restart");
    });

    it("escapes quotes in base_url and model for TOML safety", () => {
      const content = generateSetupConfigContent('prov"x', 'model"y', {
        id: "my-llama",
        api: "openai-completions",
        baseUrl: 'http://localhost:8080/v1"evil',
      });
      expect(content).toContain('provider = "prov\\"x"');
      expect(content).toContain('model = "model\\"y"');
      expect(content).toContain('base_url = "http://localhost:8080/v1\\"evil"');
      expect(content).not.toContain('base_url = "http://localhost:8080/v1"evil"');
    });
  });

  describe("escapeTomlString", () => {
    it("escapes backslashes and quotes", () => {
      expect(escapeTomlString('a\\b"c')).toBe('a\\\\b\\"c');
    });
  });

  // ── config-writer: writeProviderConfig ──

  describe("writeProviderConfig", () => {
    it("writes config with model and customProvider", () => {
      const result = writeProviderConfig("my-llama", {
        model: "llama-3.1-8b",
        customProvider: {
          id: "my-llama",
          api: "openai-completions",
          baseUrl: "http://localhost:8080/v1",
        },
      });
      expect(result.written).toBe(true);
      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain("[providers.my-llama]");
      expect(content).toContain('model = "llama-3.1-8b"');
      expect(content).not.toContain("# export");
    });

    it("does not overwrite existing config without force", () => {
      writeProviderConfig("openrouter");
      const result = writeProviderConfig("openai");
      expect(result.written).toBe(false);
      expect(result.message).toContain("already exists");
    });

    it("overwrites when force is true", () => {
      writeProviderConfig("openrouter");
      const result = writeProviderConfig("openai", { force: true });
      expect(result.written).toBe(true);
    });
  });

  // ── logic: saveProviderKey ──

  describe("saveProviderKey", () => {
    it("saves key to credential store", () => {
      const saved = saveProviderKey("test-provider", "sk-test-key-123");
      expect(saved).toBe(true);
      expect(getApiKey("test-provider")).toBe("sk-test-key-123");
      expect(hasApiKey("test-provider")).toBe(true);
    });

    it("returns false for empty key", () => {
      const saved = saveProviderKey("test-provider", "");
      expect(saved).toBe(false);
      expect(hasApiKey("test-provider")).toBe(false);
    });

    it("trims whitespace from key", () => {
      saveProviderKey("test-provider", "  sk-test-key  ");
      expect(getApiKey("test-provider")).toBe("sk-test-key");
    });
  });

  // ── logic: env-key offer (detect ≠ choose) ──

  describe("env key offer helpers", () => {
    const prevOpenCode = process.env.OPENCODE_API_KEY;

    afterEach(() => {
      if (prevOpenCode === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = prevOpenCode;
    });

    it("reads a non-empty env key for a catalog provider", () => {
      process.env.OPENCODE_API_KEY = "  sk-opencode-from-env  ";
      expect(getEnvApiKeyForProvider("opencode")).toBe("sk-opencode-from-env");
    });

    it("returns null when the env key is unset", () => {
      delete process.env.OPENCODE_API_KEY;
      expect(getEnvApiKeyForProvider("opencode")).toBeNull();
    });

    it("formats an offer message naming the env var", () => {
      process.env.OPENCODE_API_KEY = "sk-opencode-from-env";
      expect(formatEnvKeyOfferMessage("opencode")).toBe(
        "Found OPENCODE_API_KEY in your environment — use it?",
      );
    });

    it("returns null offer message when env key is absent", () => {
      delete process.env.OPENCODE_API_KEY;
      expect(formatEnvKeyOfferMessage("opencode")).toBeNull();
    });

    it("adoptEnvKeyForProvider persists the env value into the credential store", () => {
      process.env.OPENCODE_API_KEY = "sk-opencode-from-env";
      expect(hasApiKey("opencode")).toBe(false);
      expect(adoptEnvKeyForProvider("opencode")).toBe(true);
      expect(getApiKey("opencode")).toBe("sk-opencode-from-env");
      expect(hasApiKey("opencode")).toBe(true);
    });

    it("adoptEnvKeyForProvider returns false when env key is missing", () => {
      delete process.env.OPENCODE_API_KEY;
      expect(adoptEnvKeyForProvider("opencode")).toBe(false);
      expect(hasApiKey("opencode")).toBe(false);
    });
  });

  // ── logic: tryAutoSelectProvider ──

  describe("tryAutoSelectProvider", () => {
    // Known provider env keys that might leak from the dev environment.
    const PROVIDER_ENV_KEYS = [
      "OPENROUTER_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "DEEPSEEK_API_KEY",
      "GROQ_API_KEY",
      "XAI_API_KEY",
      "FIREWORKS_API_KEY",
      "OPENCODE_API_KEY",
      "TOGETHER_API_KEY",
      "UMANS_AI_CODING_PLAN_API_KEY",
      "NVIDIA_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "MISTRAL_API_KEY",
    ];
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of PROVIDER_ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
    });

    afterEach(() => {
      for (const k of PROVIDER_ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    it("returns null when no key-requiring providers are available", () => {
      expect(tryAutoSelectProvider()).toBeNull();
    });

    it("returns null when multiple key-requiring providers are available", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.OPENAI_API_KEY = "sk-test";
      expect(tryAutoSelectProvider()).toBeNull();
    });

    it("returns null when the only available provider is user-declared", () => {
      setUserProviders({
        "my-custom": {
          api: "openai-completions",
          base_url: "http://localhost:8080/v1",
          env_key: "MY_CUSTOM_KEY",
        },
      });
      process.env.MY_CUSTOM_KEY = "test-key";
      expect(tryAutoSelectProvider()).toBeNull();
    });

    it("adopts the env key when exactly one known provider has an env key", () => {
      process.env.DEEPSEEK_API_KEY = "sk-deepseek-from-env";
      expect(hasApiKey("deepseek")).toBe(false);
      const result = tryAutoSelectProvider();
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("deepseek");
      expect(result!.adoptedFromEnv).toBe(true);
      expect(result!.envKey).toBe("DEEPSEEK_API_KEY");
      // Key was copied into the credential store.
      expect(hasApiKey("deepseek")).toBe(true);
      expect(getApiKey("deepseek")).toBe("sk-deepseek-from-env");
    });

    it("returns adoptedFromEnv=false when the key is already in the credential store", () => {
      setApiKey("deepseek", "sk-deepseek-stored");
      process.env.DEEPSEEK_API_KEY = "sk-deepseek-from-env";
      const result = tryAutoSelectProvider();
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("deepseek");
      expect(result!.adoptedFromEnv).toBe(false);
      // Store value unchanged (not overwritten by env).
      expect(getApiKey("deepseek")).toBe("sk-deepseek-stored");
    });

    it("picks DEFAULT_MODELS[provider] as the model", () => {
      process.env.DEEPSEEK_API_KEY = "sk-deepseek-from-env";
      const result = tryAutoSelectProvider();
      expect(result).not.toBeNull();
      expect(result!.model).toBe(DEFAULT_MODELS["deepseek"]);
    });

    it("returns null when the env key is whitespace-only", () => {
      process.env.DEEPSEEK_API_KEY = "   ";
      expect(tryAutoSelectProvider()).toBeNull();
    });
  });

  // ── logic: fetchProviderModels ──

  describe("fetchProviderModels", () => {
    it("returns empty array for provider without live catalog support", async () => {
      const models = await fetchProviderModels("anthropic");
      // anthropic doesn't support live catalog (not OpenAI-compatible)
      expect(models).toEqual([]);
    });
  });

  // ── logic: fetchCustomProviderModels ──

  describe("fetchCustomProviderModels", () => {
    it("returns null on fetch failure", async () => {
      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockRejectedValue(new Error("Connection refused"));

      const models = await fetchCustomProviderModels(
        "http://localhost:1/v1",
        "test-key",
      );
      expect(models).toBeNull();

      fetchSpy.mockRestore();
    });
  });

  // ── logic: pickDefaultModel ──

  describe("pickDefaultModel", () => {
    it("picks first live model when available", () => {
      const models = [
        { id: "model-a", contextWindow: 128000 },
        { id: "model-b", contextWindow: 8000 },
      ];
      expect(pickDefaultModel("test", models)).toBe("model-a");
    });

    it("falls back to catalog when no live models and no DEFAULT_MODELS entry", () => {
      // openrouter has no DEFAULT_MODELS entry (removed — was stale).
      // pickDefaultModel should fall through to pickFirstCatalogModel,
      // returning a model from the pi-ai catalog or empty string.
      const result = pickDefaultModel("openrouter");
      expect(typeof result).toBe("string");
    });

    it("returns empty string when no model found", () => {
      expect(pickDefaultModel("nonexistent-provider")).toBe("");
    });
  });

  // ── logic: finalizeProviderSetup ──

  describe("finalizeProviderSetup", () => {
    it("does not include 'restart' in message when key saved", () => {
      const result = finalizeProviderSetup("test-provider", "write", {
        model: "test-model",
        keySaved: true,
      });
      expect(result.success).toBe(true);
      expect(result.keySaved).toBe(true);
      expect(result.message.toLowerCase()).not.toContain("restart");
      expect(result.message).toContain("credentials.json");
    });

    it("does not include 'export' in message", () => {
      const result = finalizeProviderSetup("test-provider", "write", {
        model: "test-model",
        keySaved: true,
      });
      expect(result.message.toLowerCase()).not.toContain("export");
    });

    it("writes customProvider section to config", () => {
      const result = finalizeProviderSetup("my-llama", "write", {
        model: "llama-3.1-8b",
        customProvider: {
          id: "my-llama",
          api: "openai-completions",
          baseUrl: "http://localhost:8080/v1",
        },
        keySaved: true,
      });
      expect(result.success).toBe(true);
      const configContent = readFileSync(getSetupConfigPath(), "utf-8");
      expect(configContent).toContain("[providers.my-llama]");
      expect(configContent).toContain('base_url = "http://localhost:8080/v1"');
    });
  });

  // ── validation: isValidCustomProviderId ──

  describe("isValidCustomProviderId", () => {
    it("accepts valid ids", () => {
      expect(isValidCustomProviderId("my-llama").valid).toBe(true);
      expect(isValidCustomProviderId("vllm-local").valid).toBe(true);
      expect(isValidCustomProviderId("lm-studio").valid).toBe(true);
      expect(isValidCustomProviderId("123").valid).toBe(true);
    });

    it("rejects empty id", () => {
      const result = isValidCustomProviderId("");
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("rejects uppercase", () => {
      expect(isValidCustomProviderId("MyLlama").valid).toBe(false);
    });

    it("rejects spaces", () => {
      expect(isValidCustomProviderId("my llama").valid).toBe(false);
    });

    it("rejects known provider ids", () => {
      const result = isValidCustomProviderId("openrouter");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("already");
    });
  });

  // ── validation: isValidBaseUrl ──

  describe("isValidBaseUrl", () => {
    it("accepts http URL", () => {
      expect(isValidBaseUrl("http://localhost:8080/v1").valid).toBe(true);
    });

    it("accepts https URL", () => {
      expect(isValidBaseUrl("https://api.example.com/v1").valid).toBe(true);
    });

    it("rejects non-URL", () => {
      expect(isValidBaseUrl("not-a-url").valid).toBe(false);
    });

    it("rejects empty", () => {
      expect(isValidBaseUrl("").valid).toBe(false);
    });

    it("rejects quotes and control characters", () => {
      expect(isValidBaseUrl('http://x.com/"evil').valid).toBe(false);
      expect(isValidBaseUrl("http://x.com/\nfoo").valid).toBe(false);
    });
  });

  describe("providerRequiresApiKey", () => {
    it("returns true for catalog providers with an env key", () => {
      expect(providerRequiresApiKey("openrouter")).toBe(true);
    });

    it("returns false for keyless registry providers", () => {
      expect(providerRequiresApiKey("ollama")).toBe(false);
    });
  });

  // ── provider-options: buildProviderSelectItems ──

  describe("buildProviderSelectItems", () => {
    it("includes custom provider entry at top", () => {
      const items = buildProviderSelectItems();
      expect(items[0].value).toBe(CUSTOM_PROVIDER_VALUE);
      expect(items[0].label).toContain("Custom");
    });

    it("includes known providers after custom entry", () => {
      const items = buildProviderSelectItems();
      const values = items.map((i) => i.value);
      expect(values).toContain("openrouter");
      expect(values).toContain("openai");
    });
  });

  // ── provider-catalog: fetchModelsFromEndpoint ──

  describe("fetchModelsFromEndpoint", () => {
    it("parses /v1/models response with context_length", async () => {
      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(
        {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "llama-3.1-8b", context_length: 128000 },
              { id: "llama-3.1-70b", context_length: 128000 },
            ],
          }),
        } as any,
      );

      const models = await fetchModelsFromEndpoint(
        "http://localhost:8080/v1",
        "test-key",
      );
      expect(models).toHaveLength(2);
      // Sorted alphabetically
      expect(models[0].id).toBe("llama-3.1-70b");
      expect(models[0].contextWindow).toBe(128000);
      expect(models[1].id).toBe("llama-3.1-8b");

      fetchSpy.mockRestore();
    });

    it("throws on HTTP error", async () => {
      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(
        {
          ok: false,
          status: 401,
          json: async () => ({}),
        } as any,
      );

      await expect(
        fetchModelsFromEndpoint("http://localhost:8080/v1", "bad-key"),
      ).rejects.toThrow();

      fetchSpy.mockRestore();
    });

    it("handles empty model list", async () => {
      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(
        {
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        } as any,
      );

      const models = await fetchModelsFromEndpoint("http://localhost:8080/v1");
      expect(models).toEqual([]);

      fetchSpy.mockRestore();
    });

    it("includes Authorization header when apiKey provided", async () => {
      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(
        {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "test-model" }] }),
        } as any,
      );

      await fetchModelsFromEndpoint("http://localhost:8080/v1", "my-secret-key");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const callArgs = fetchSpy.mock.calls[0];
      const opts = callArgs[1] as RequestInit;
      expect(opts.headers).toEqual({
        Accept: "application/json",
        Authorization: "Bearer my-secret-key",
      });

      fetchSpy.mockRestore();
    });
  });
});
