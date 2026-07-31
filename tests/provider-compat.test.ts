import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProvider } from "../src/llm.js";
import {
  resetCredentialStoreForTests,
  setApiKey,
  resolveApiKey,
} from "../src/credentials.js";
import { getProviderEnvKeys } from "../src/provider-registry.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";

describe("openai-compatible provider wire compat", () => {
  let praanaHome: string;
  let prevHome: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-compat-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "llm", writeLine: () => {} }));
    resetCredentialStoreForTests();
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

  it("applies poolside compat so store/stream_options/developer are disabled", () => {
    setApiKey("poolside", " pk-test \n");
    const model = createProvider({
      provider: "poolside",
      model: "poolside/laguna-s-2.1",
    })("poolside/laguna-s-2.1") as {
      compat?: Record<string, unknown>;
      __piOptions?: { apiKey?: string };
    };
    expect(model.compat?.supportsStore).toBe(false);
    expect(model.compat?.supportsDeveloperRole).toBe(false);
    expect(model.compat?.supportsUsageInStreaming).toBe(false);
    expect(model.compat?.maxTokensField).toBe("max_tokens");
    // Trimmed on save
    expect(model.__piOptions?.apiKey).toBe("pk-test");
  });

  it("applies umans compat and accepts UMANS_API_KEY alias env", () => {
    savedEnv.UMANS_API_KEY = process.env.UMANS_API_KEY;
    savedEnv.UMANS_AI_CODING_PLAN_API_KEY = process.env.UMANS_AI_CODING_PLAN_API_KEY;
    delete process.env.UMANS_API_KEY;
    process.env.UMANS_AI_CODING_PLAN_API_KEY = "sk-alias-key";

    expect(getProviderEnvKeys("umans")).toEqual([
      "UMANS_API_KEY",
      "UMANS_AI_CODING_PLAN_API_KEY",
    ]);
    expect(resolveApiKey("umans", "UMANS_API_KEY", ["UMANS_AI_CODING_PLAN_API_KEY"])).toBe(
      "sk-alias-key",
    );

    const model = createProvider({
      provider: "umans",
      model: "umans-coder",
    })("umans-coder") as {
      compat?: Record<string, unknown>;
      __piOptions?: { apiKey?: string };
    };
    expect(model.compat?.supportsStore).toBe(false);
    expect(model.__piOptions?.apiKey).toBe("sk-alias-key");
  });
});
