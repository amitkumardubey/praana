import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  executeSlashCommand,
  SLASH_COMMAND_METADATA,
} from "../src/slash-commands.js";
import {
  setApiKey,
  listStoredProviders,
  resetCredentialStoreForTests,
} from "../src/credentials.js";
import {
  appendProviderSection,
  removeProviderSection,
  updateLlmProvider,
  getSetupConfigPath,
} from "../src/setup/config-writer.js";
import {
  setUserProviders,
  resetUserProvidersForTests,
} from "../src/provider-registry.js";
import type { Session } from "../src/session.js";
import type { CustomProviderConfig } from "../src/setup/types.js";
import { providerEnvKeyNames } from "./helpers/provider-env-keys.js";

const PROVIDER_ENV_KEYS = providerEnvKeyNames();

function createMockSession(
  effectiveProvider = "openrouter",
  extras?: {
    model?: string;
    setProviderOverride?: ReturnType<typeof mock>;
    setModelOverride?: ReturnType<typeof mock>;
  },
): Session {
  const config = {
    llm: { provider: effectiveProvider, model: extras?.model ?? "openai/gpt-4.1" },
    providers: {} as Record<string, unknown>,
  };
  return {
    getEffectiveProvider: () => effectiveProvider,
    getActiveModelId: () => extras?.model ?? "openai/gpt-4.1",
    setProviderOverride: extras?.setProviderOverride ?? mock(),
    setModelOverride: extras?.setModelOverride ?? mock(),
    config,
  } as unknown as Session;
}

function ensureConfigDir(): string {
  const configPath = getSetupConfigPath();
  mkdirSync(join(configPath, ".."), { recursive: true });
  return configPath;
}

describe("/login and /logout", () => {
  let tmpHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "praana-login-test-"));
    process.env.PRAANA_HOME = tmpHome;
    resetCredentialStoreForTests();
    resetUserProvidersForTests();
    for (const key of PROVIDER_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    delete process.env.PRAANA_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
    resetCredentialStoreForTests();
    resetUserProvidersForTests();
    for (const key of PROVIDER_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  // ── /login dispatch ──

  describe("/login", () => {
    it("returns open_login_wizard action with no provider hint", async () => {
      const session = createMockSession();
      const result = await executeSlashCommand("/login", session, {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => false,
      });
      expect(result.action).toBe("open_login_wizard");
      expect(result.loginProviderHint).toBeUndefined();
    });

    it("returns open_login_wizard action with provider hint", async () => {
      const session = createMockSession();
      const result = await executeSlashCommand("/login openrouter", session, {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => false,
      });
      expect(result.action).toBe("open_login_wizard");
      expect(result.loginProviderHint).toBe("openrouter");
    });

    it("returns open_setup_wizard for /setup", async () => {
      const session = createMockSession();
      const result = await executeSlashCommand("/setup", session, {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => false,
      });
      expect(result.action).toBe("open_setup_wizard");
      expect(result.display).toBe("toast");
    });
  });

  // ── /logout dispatch ──

  describe("/logout", () => {
    it("returns info toast when no providers are logged in", async () => {
      const session = createMockSession();
      const result = await executeSlashCommand("/logout", session, {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => false,
      });
      expect(result.action).toBe("none");
      expect(result.display).toBe("toast");
      expect(result.toastTone).toBe("info");
      expect(result.lines.join(" ")).toContain("No providers logged in");
    });

    it("returns open_logout_wizard action with a single stored provider", async () => {
      setApiKey("openrouter", "sk-test-123");
      const session = createMockSession("openrouter");
      const result = await executeSlashCommand("/logout", session, {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => false,
      });
      expect(result.action).toBe("open_logout_wizard");
      expect(result.display).toBe("toast");
      // Key NOT removed — the wizard does the removal, not the dispatch
      expect(listStoredProviders()).toEqual(["openrouter"]);
    });

    it("returns open_logout_wizard action with multiple stored providers", async () => {
      setApiKey("openrouter", "sk-test-1");
      setApiKey("openai", "sk-test-2");
      const session = createMockSession("openrouter");
      const result = await executeSlashCommand("/logout", session, {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => false,
      });
      expect(result.action).toBe("open_logout_wizard");
      expect(result.display).toBe("toast");
      // Neither removed — wizard handles it
      expect(listStoredProviders().sort()).toEqual(["openai", "openrouter"]);
    });

    it("removes a specific provider's credentials", async () => {
      setApiKey("openrouter", "sk-test-1");
      setApiKey("openai", "sk-test-2");
      const session = createMockSession("openrouter");
      const result = await executeSlashCommand("/logout openai", session, {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => false,
      });
      expect(result.action).toBe("refresh_status");
      expect(result.toastTone).toBe("success");
      expect(result.lines.join(" ")).toContain("Logged out: openai");
      expect(listStoredProviders()).toEqual(["openrouter"]);
    });

    it("switches to a fallback provider when logging out the active one", async () => {
      setApiKey("openrouter", "sk-test-1");
      setApiKey("openai", "sk-test-2");
      const setProviderOverride = mock();
      const setModel = mock();
      const session = createMockSession("openrouter", { setProviderOverride });
      const result = await executeSlashCommand("/logout openrouter", session, {
        setModel,
        setThinking: mock(),
        getThinking: () => false,
      });
      expect(result.action).toBe("refresh_status");
      expect(result.lines.join(" ")).toContain("Logged out of openrouter");
      expect(result.lines.join(" ")).toContain("Switched active provider to openai");
      expect(result.lines.join(" ")).not.toContain("next turn may fail");
      expect(listStoredProviders()).toEqual(["openai"]);
      expect(setProviderOverride).toHaveBeenCalled();
      expect(setModel).toHaveBeenCalled();
    });

    it("opens login when logging out the last stored provider", async () => {
      setApiKey("openrouter", "sk-test-1");
      const session = createMockSession("openrouter");
      const result = await executeSlashCommand("/logout openrouter", session, {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => false,
      });
      expect(result.action).toBe("open_login_wizard");
      expect(result.lines.join(" ")).toContain("opening login");
    });

    it("warns when an env var still shadows logout", async () => {
      setApiKey("openai", "sk-test-1");
      const previous = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-from-env";
      try {
        const session = createMockSession("openrouter");
        const result = await executeSlashCommand("/logout openai", session, {
          setModel: mock(),
          setThinking: mock(),
          getThinking: () => false,
        });
        expect(result.lines.join(" ")).toContain("OPENAI_API_KEY is still exported");
      } finally {
        if (previous === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous;
      }
    });

    it("returns error when provider has no credentials", async () => {
      const session = createMockSession();
      const result = await executeSlashCommand("/logout nonexistent", session, {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => false,
      });
      expect(result.action).toBe("none");
      expect(result.toastTone).toBe("error");
      expect(result.lines.join(" ")).toContain("No credentials found");
    });

    it("removes both credentials and config section for user-declared provider", async () => {
      // Register a user-declared provider
      setUserProviders({
        "my-llama": {
          api: "openai-completions",
          base_url: "http://localhost:8080/v1",
          env_key: "MY_LLAMA_KEY",
        },
      });

      // Add a credential for it
      setApiKey("my-llama", "tok-test-123");

      // Write a config.toml with the provider section
      const configPath = ensureConfigDir();
      writeFileSync(
        configPath,
        `[llm]\nprovider = "openrouter"\nmodel = "x"\n\n[providers.my-llama]\napi = "openai-completions"\nbase_url = "http://localhost:8080/v1"\nenv_key = "MY_LLAMA_KEY"\n`,
        "utf-8",
      );

      const session = createMockSession("openrouter");
      const result = await executeSlashCommand("/logout my-llama", session, {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => false,
      });

      expect(result.action).toBe("refresh_status");
      expect(result.toastTone).toBe("success");
      expect(result.lines.join(" ")).toContain("Logged out: my-llama");
      expect(result.lines.join(" ")).toContain("[providers.my-llama]");
      expect(result.lines.join(" ")).not.toContain("/new");

      // Credential should be removed
      expect(listStoredProviders()).toEqual([]);

      // Config section should be removed
      const configContent = readFileSync(configPath, "utf-8");
      expect(configContent).not.toContain("[providers.my-llama]");
      expect(configContent).toContain("[llm]");
      expect(configContent).toContain("openrouter");
    });
  });

  // ── Config-writer functions ──

  describe("appendProviderSection", () => {
    it("appends a provider section without clobbering existing config", () => {
      const configPath = ensureConfigDir();
      writeFileSync(
        configPath,
        `# PRAANA Config\n[llm]\nprovider = "openrouter"\nmodel = "x"\n`,
        "utf-8",
      );

      const customConfig: CustomProviderConfig = {
        id: "my-llama",
        api: "openai-completions",
        baseUrl: "http://localhost:8080/v1",
        envKey: "MY_LLAMA_KEY",
      };

      const result = appendProviderSection(customConfig);
      expect(result.written).toBe(true);

      const content = readFileSync(configPath, "utf-8");
      // Existing content preserved
      expect(content).toContain("# PRAANA Config");
      expect(content).toContain("[llm]");
      expect(content).toContain('provider = "openrouter"');
      // New section added
      expect(content).toContain("[providers.my-llama]");
      expect(content).toContain('api = "openai-completions"');
      expect(content).toContain('base_url = "http://localhost:8080/v1"');
      expect(content).toContain('env_key = "MY_LLAMA_KEY"');
    });

    it("returns not written if section already exists", () => {
      const configPath = ensureConfigDir();
      writeFileSync(
        configPath,
        `[llm]\nprovider = "openrouter"\n\n[providers.my-llama]\napi = "openai-completions"\nbase_url = "http://localhost:8080/v1"\n`,
        "utf-8",
      );

      const customConfig: CustomProviderConfig = {
        id: "my-llama",
        api: "openai-completions",
        baseUrl: "http://localhost:8080/v1",
      };

      const result = appendProviderSection(customConfig);
      expect(result.written).toBe(false);
      expect(result.message).toContain("already exists");
    });

    it("creates config file if none exists", () => {
      const customConfig: CustomProviderConfig = {
        id: "my-llama",
        api: "openai-completions",
        baseUrl: "http://localhost:8080/v1",
      };

      const result = appendProviderSection(customConfig);
      expect(result.written).toBe(true);

      const configPath = getSetupConfigPath();
      expect(existsSync(configPath)).toBe(true);
      const content = readFileSync(configPath, "utf-8");
      expect(content).toContain("[providers.my-llama]");
    });
  });

  describe("removeProviderSection", () => {
    it("removes only the named section, leaves others intact", () => {
      const configPath = ensureConfigDir();
      writeFileSync(
        configPath,
        `[llm]\nprovider = "openrouter"\nmodel = "x"\n\n[providers.foo]\napi = "openai-completions"\nbase_url = "http://localhost:8080/v1"\n\n[providers.bar]\napi = "openai-completions"\nbase_url = "http://localhost:9090/v1"\n`,
        "utf-8",
      );

      const result = removeProviderSection("foo");
      expect(result.written).toBe(true);

      const content = readFileSync(configPath, "utf-8");
      // foo removed
      expect(content).not.toContain("[providers.foo]");
      // bar intact
      expect(content).toContain("[providers.bar]");
      expect(content).toContain("http://localhost:9090/v1");
      // llm section intact
      expect(content).toContain("[llm]");
      expect(content).toContain("openrouter");
    });

    it("returns not written if section not found", () => {
      const configPath = ensureConfigDir();
      writeFileSync(configPath, `[llm]\nprovider = "openrouter"\n`, "utf-8");

      const result = removeProviderSection("nonexistent");
      expect(result.written).toBe(false);
      expect(result.message).toContain("not found");
    });

    it("returns not written if no config file exists", () => {
      const result = removeProviderSection("anything");
      expect(result.written).toBe(false);
    });
  });

  describe("updateLlmProvider", () => {
    it("updates the provider line in [llm] without clobbering other sections", () => {
      const configPath = ensureConfigDir();
      writeFileSync(
        configPath,
        `[llm]\nprovider = "openrouter"\nmodel = "old-model"\n\n[providers.my-llama]\napi = "openai-completions"\nbase_url = "http://localhost:8080/v1"\n`,
        "utf-8",
      );

      const result = updateLlmProvider("openai", "gpt-4o");
      expect(result.written).toBe(true);

      const content = readFileSync(configPath, "utf-8");
      expect(content).toContain('provider = "openai"');
      expect(content).toContain('model = "gpt-4o"');
      // Other section preserved
      expect(content).toContain("[providers.my-llama]");
      expect(content).toContain("http://localhost:8080/v1");
    });

    it("inserts provider line if [llm] section has none", () => {
      const configPath = ensureConfigDir();
      writeFileSync(
        configPath,
        `[llm]\nmodel = "x"\n\n[some-other-section]\nfoo = "bar"\n`,
        "utf-8",
      );

      const result = updateLlmProvider("openai");
      expect(result.written).toBe(true);

      const content = readFileSync(configPath, "utf-8");
      expect(content).toContain('provider = "openai"');
      expect(content).toContain("[some-other-section]");
    });
  });

  // ── SLASH_COMMAND_METADATA ──

  describe("SLASH_COMMAND_METADATA", () => {
    it("includes /login and /logout", () => {
      const names = SLASH_COMMAND_METADATA.map((c) => c.name);
      expect(names).toContain("/login");
      expect(names).toContain("/logout");
    });

    it("/login has argumentHint", () => {
      const login = SLASH_COMMAND_METADATA.find((c) => c.name === "/login");
      expect(login?.argumentHint).toBe("[provider]");
    });

    it("/logout has argumentHint", () => {
      const logout = SLASH_COMMAND_METADATA.find((c) => c.name === "/logout");
      expect(logout?.argumentHint).toBe("[provider]");
    });
  });
});
