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
} from "../src/setup/config-writer.js";
import {
  saveProviderKey,
  fetchProviderModels,
  fetchCustomProviderModels,
  pickDefaultModel,
  finalizeProviderSetup,
  isValidCustomProviderId,
  isValidBaseUrl,
} from "../src/setup/logic.js";
import {
  buildProviderSelectItems,
  CUSTOM_PROVIDER_VALUE,
} from "../src/setup/provider-options.js";
import {
  getApiKey,
  hasApiKey,
  resetCredentialStoreForTests,
} from "../src/credentials.js";
import { resetUserProvidersForTests } from "../src/provider-registry.js";
import {
  fetchModelsFromEndpoint,
  resetProviderCatalogCacheForTests,
} from "../src/provider-catalog.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";

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

    it("falls back to DEFAULT_MODELS when no live models", () => {
      expect(pickDefaultModel("openrouter")).toBe(
        "deepseek/deepseek-v4-flash:free",
      );
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
