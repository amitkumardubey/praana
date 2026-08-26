import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getProviderConfig,
  getProviderEnvKey,
  getMissingKeyMessage,
  isProviderAvailable,
  listKnownProviders,
  inferReasoningModel,
  createProvider,
  getReasoningEffort,
  parseReasoningEffort,
  REASONING_EFFORT_LEVELS,
} from "../src/llm.js";
import {
  setUserProviders,
  resetUserProvidersForTests,
} from "../src/provider-registry.js";
import {
  setApiKey,
  resetCredentialStoreForTests,
} from "../src/credentials.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("llm provider registry", () => {
  // Isolate the credential store so keys stored in the developer's real
  // ~/.praana/credentials.json cannot make providers look "available".
  let praanaHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-llm-registry-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "llm", writeLine: () => {} }));
    resetUserProvidersForTests();
    resetCredentialStoreForTests();
  });

  afterEach(() => {
    resetUserProvidersForTests();
    resetCredentialStoreForTests();
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  it("includes opencode with OpenCode Zen endpoint", () => {
    const pc = getProviderConfig("opencode");
    expect(pc.provider).toBe("opencode");
    expect(pc.api).toBe("openai-completions");
    expect(pc.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(pc.envKey).toBe("OPENCODE_API_KEY");
  });

  it("lists opencode", () => {
    expect(listKnownProviders()).toContain("opencode");
  });

  it("requires OPENCODE_API_KEY for opencode", () => {
    const prev = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    expect(getProviderEnvKey("opencode")).toBe("OPENCODE_API_KEY");
    expect(getMissingKeyMessage("opencode")).toMatch(/OPENCODE_API_KEY/);
    if (prev !== undefined) process.env.OPENCODE_API_KEY = prev;
  });

  it("infers reasoning for kimi model ids", () => {
    expect(inferReasoningModel("openrouter", "kimi-k2.7-code")).toBe(true);
    expect(inferReasoningModel("openrouter", "moonshotai/kimi-k2.5")).toBe(true);
    expect(inferReasoningModel("openrouter", "gpt-4o")).toBe(false);
  });

  it("treats pi-ai providers without configured keys as unavailable", () => {
    const prevMoonshot = process.env.MOONSHOT_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    expect(isProviderAvailable("moonshotai")).toBe(false);
    if (prevMoonshot !== undefined) process.env.MOONSHOT_API_KEY = prevMoonshot;
  });

  it("treats keyless registry providers as available", () => {
    expect(isProviderAvailable("ollama")).toBe(true);
  });

  it("includes known providers in the list", () => {
    const providers = listKnownProviders();
    expect(providers).toContain("cerebras");
    expect(providers).toContain("umans");
    expect(providers).toContain("anthropic");
  });

  it("treats amazon-bedrock as unavailable without AWS credentials", () => {
    const original = { ...process.env };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_PROFILE;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    expect(isProviderAvailable("amazon-bedrock")).toBe(false);
    process.env = original;
  });

  it("treats amazon-bedrock as available with AWS credentials", () => {
    const original = { ...process.env };
    delete process.env.AWS_PROFILE;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    process.env.AWS_ACCESS_KEY_ID = "test";
    expect(isProviderAvailable("amazon-bedrock")).toBe(true);
    process.env = original;
  });
});

describe("user-declared providers", () => {
  let praanaHome: string;
  let prevHome: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-llm-user-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "llm", writeLine: () => {} }));
    resetUserProvidersForTests();
    resetCredentialStoreForTests();
  });

  afterEach(() => {
    resetUserProvidersForTests();
    resetCredentialStoreForTests();
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete savedEnv[k];
    }
  });

  it("getProviderConfig returns user-declared provider first", () => {
    setUserProviders({
      "my-llama": {
        api: "openai-completions",
        base_url: "http://localhost:8080/v1",
      },
    });
    const pc = getProviderConfig("my-llama");
    expect(pc.api).toBe("openai-completions");
    expect(pc.baseUrl).toBe("http://localhost:8080/v1");
    expect(pc.provider).toBe("my-llama");
    expect(pc.envKey).toBeNull();
  });

  it("getProviderConfig falls back to registry for non-user-declared providers", () => {
    const pc = getProviderConfig("openrouter");
    expect(pc.provider).toBe("openrouter");
    expect(pc.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("listKnownProviders includes user-declared provider ids", () => {
    setUserProviders({
      "my-custom": {
        api: "openai-completions",
        base_url: "http://localhost:8080/v1",
      },
    });
    expect(listKnownProviders()).toContain("my-custom");
  });

  it("isProviderAvailable returns true when key is in credential store", () => {
    setUserProviders({
      "stored-key": {
        api: "openai-completions",
        base_url: "http://localhost:8080/v1",
        env_key: "STORED_KEY",
      },
    });
    savedEnv.STORED_KEY = process.env.STORED_KEY;
    delete process.env.STORED_KEY;
    expect(isProviderAvailable("stored-key")).toBe(false);
    setApiKey("stored-key", "sk-from-store");
    expect(isProviderAvailable("stored-key")).toBe(true);
  });

  it("isProviderAvailable returns true for keyless user-declared provider", () => {
    setUserProviders({
      "keyless": {
        api: "openai-completions",
        base_url: "http://localhost:8080/v1",
      },
    });
    expect(isProviderAvailable("keyless")).toBe(true);
  });

  it("isProviderAvailable checks env_key fallback for user-declared provider", () => {
    setUserProviders({
      "env-only": {
        api: "openai-completions",
        base_url: "http://localhost:8080/v1",
        env_key: "MY_ENV_KEY",
      },
    });
    savedEnv.MY_ENV_KEY = process.env.MY_ENV_KEY;
    delete process.env.MY_ENV_KEY;
    expect(isProviderAvailable("env-only")).toBe(false);
    process.env.MY_ENV_KEY = "env-value";
    expect(isProviderAvailable("env-only")).toBe(true);
  });

  it("buildModel uses user-declared base_url and model metadata", () => {
    setUserProviders({
      "my-llama": {
        api: "openai-completions",
        base_url: "http://localhost:8080/v1",
        models: [
          {
            id: "llama-3.1-8b",
            context_window: 128000,
            reasoning: false,
            max_tokens: 4096,
          },
        ],
      },
    });
    const build = createProvider({ provider: "my-llama", model: "llama-3.1-8b" });
    const model = build("llama-3.1-8b") as Record<string, unknown>;
    expect(model.baseUrl).toBe("http://localhost:8080/v1");
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("my-llama");
    expect(model.contextWindow).toBe(128000);
    expect(model.maxTokens).toBe(4096);
    expect(model.reasoning).toBe(false);
  });

  it("buildModel resolves API key from credential store", () => {
    setUserProviders({
      "keyed-provider": {
        api: "openai-completions",
        base_url: "http://localhost:8080/v1",
        env_key: "KEYED_ENV",
      },
    });
    savedEnv.KEYED_ENV = process.env.KEYED_ENV;
    delete process.env.KEYED_ENV;
    setApiKey("keyed-provider", "sk-from-store");
    const build = createProvider({ provider: "keyed-provider", model: "test-model" });
    const model = build("test-model") as Record<string, unknown>;
    const piOpts = model.__piOptions as Record<string, unknown> | undefined;
    expect(piOpts?.apiKey).toBe("sk-from-store");
  });

  it("buildModel returns 'no-key' for keyless user-declared provider", () => {
    setUserProviders({
      "keyless": {
        api: "openai-completions",
        base_url: "http://localhost:8080/v1",
      },
    });
    const build = createProvider({ provider: "keyless", model: "test-model" });
    const model = build("test-model") as Record<string, unknown>;
    const piOpts = model.__piOptions as Record<string, unknown> | undefined;
    expect(piOpts?.apiKey).toBe("no-key");
  });
});

describe("reasoning effort", () => {
  it("parseReasoningEffort accepts pi-ai levels and none→off", () => {
    expect(parseReasoningEffort("medium")).toBe("medium");
    expect(parseReasoningEffort("NONE")).toBe("off");
    expect(parseReasoningEffort("off")).toBe("off");
    expect(parseReasoningEffort("xhigh")).toBe("xhigh");
    expect(parseReasoningEffort("bogus")).toBeNull();
    expect(REASONING_EFFORT_LEVELS).toContain("medium");
  });

  it("getReasoningEffort returns medium for OpenRouter GLM (not off)", () => {
    const model = { reasoning: true };
    const effort = getReasoningEffort(model, "z-ai/glm-5.2", "openrouter");
    expect(effort).toBe("medium");
    expect(effort).not.toBe("off");
  });

  it("getReasoningEffort honours preferred level when supported", () => {
    const model = { reasoning: true };
    expect(getReasoningEffort(model, "z-ai/glm-5.2", "openrouter", "high")).toBe(
      "high",
    );
    expect(getReasoningEffort(model, "z-ai/glm-5.2", "openrouter", "low")).toBe(
      "low",
    );
  });

  it("getReasoningEffort never returns off (OpenRouter-illegal); omits instead", () => {
    const model = {
      reasoning: true,
      thinkingLevelMap: { off: "none" },
    };
    const effort = getReasoningEffort(model, "some-model", "openrouter", "off");
    expect(effort).toBeUndefined();
  });

  it("getReasoningEffort keeps effort on for mandatory kimi reasoning models", () => {
    const model = {
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
    };
    const effort = getReasoningEffort(
      model,
      "moonshotai/kimi-k2.7-code",
      "openrouter",
      "off",
    );
    expect(effort).toBeTruthy();
    expect(effort).not.toBe("off");
  });

  it("infers reasoning for umans glm and kimi model ids", () => {
    expect(inferReasoningModel("umans", "umans-glm-5.2")).toBe(true);
    expect(inferReasoningModel("umans", "umans-kimi-k2.7-code")).toBe(true);
    expect(inferReasoningModel("umans", "kimi-k2.7-code")).toBe(true);
  });
});
