import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createProvider,
  getMissingKeyMessage,
  isProviderAvailable,
} from "../src/llm.js";
import {
  resetCredentialStoreForTests,
  setOAuthToken,
} from "../src/credentials.js";
import { PROVIDER_REGISTRY } from "../src/provider-registry.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";

describe("llm oauth providers", () => {
  let praanaHome: string;
  let prevHome: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-llm-oauth-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "llm", writeLine: () => {} }));
    resetCredentialStoreForTests();
    for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
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

  it("registers openai-codex and github-copilot", () => {
    expect(PROVIDER_REGISTRY["openai-codex"]?.provider).toBe("openai-codex");
    expect(PROVIDER_REGISTRY["github-copilot"]?.provider).toBe("github-copilot");
  });

  it("openai-codex unavailable without oauth credentials", () => {
    expect(isProviderAvailable("openai-codex")).toBe(false);
    expect(getMissingKeyMessage("openai-codex")).toContain("/login openai-codex");
  });

  it("openai-codex available when oauth token stored", () => {
    setOAuthToken("openai-codex", {
      access: "codex-access",
      refresh: "codex-refresh",
      expires: Date.now() + 3_600_000,
    });
    expect(isProviderAvailable("openai-codex")).toBe(true);
    expect(getMissingKeyMessage("openai-codex")).toBeNull();
  });

  it("buildModel passes oauth access token as apiKey for openai-codex", () => {
    setOAuthToken("openai-codex", {
      access: "codex-access-token",
      refresh: "codex-refresh",
      expires: Date.now() + 3_600_000,
    });
    const model = createProvider({
      provider: "openai-codex",
      model: "gpt-5.4",
    })("gpt-5.4") as { __piOptions?: { apiKey?: string }; provider?: string };
    expect(model.provider).toBe("openai-codex");
    expect(model.__piOptions?.apiKey).toBe("codex-access-token");
  });

  it("github-copilot available via COPILOT_GITHUB_TOKEN env", () => {
    process.env.COPILOT_GITHUB_TOKEN = "gho_test";
    expect(isProviderAvailable("github-copilot")).toBe(true);
  });

  it("anthropic oauth credentials make the provider available", () => {
    setOAuthToken("anthropic", {
      access: "sk-ant-oat-test",
      refresh: "refresh",
      expires: Date.now() + 3_600_000,
    });
    expect(isProviderAvailable("anthropic")).toBe(true);
  });
});
