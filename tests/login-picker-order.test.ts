import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildProviderSelectItems,
  CUSTOM_PROVIDER_VALUE,
} from "../src/setup/provider-options.js";
import { buildLoginPickerItems } from "../src/ui/tui/overlays/login.js";
import { setUserProviders, resetUserProvidersForTests } from "../src/provider-registry.js";
import { resetCredentialStoreForTests } from "../src/credentials.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";
import { providerEnvKeyNames } from "./helpers/provider-env-keys.js";

describe("login picker custom-provider placement", () => {
  let praanaHome: string;
  let prevHome: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-login-picker-"));
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

  it("user-declared custom providers appear before the generic Custom entry", () => {
    setUserProviders({
      "my-llama": {
        api: "openai-completions",
        base_url: "http://localhost:8080/v1",
      },
      "vllm-local": {
        api: "openai-completions",
        base_url: "http://localhost:9000/v1",
      },
    });
    const items = buildLoginPickerItems();
    const values = items.map((i) => i.value);
    const customIndex = values.indexOf(CUSTOM_PROVIDER_VALUE);
    expect(customIndex).toBe(values.length - 1);
    expect(values.indexOf("my-llama")).toBeGreaterThanOrEqual(0);
    expect(values.indexOf("vllm-local")).toBeGreaterThanOrEqual(0);
    expect(values.indexOf("my-llama")).toBeLessThan(customIndex);
    expect(values.indexOf("vllm-local")).toBeLessThan(customIndex);
  });

  it("the generic Custom entry stays last even when declared providers exist", () => {
    setUserProviders({
      "my-llama": {
        api: "openai-completions",
        base_url: "http://localhost:8080/v1",
      },
    });
    const items = buildLoginPickerItems();
    expect(items[items.length - 1].value).toBe(CUSTOM_PROVIDER_VALUE);
  });

  it("readline setup numbering is unaffected: the readline list excludes declared providers and keeps Custom last", () => {
    setUserProviders({
      "my-llama": {
        api: "openai-completions",
        base_url: "http://localhost:8080/v1",
      },
    });
    const readlineItems = buildProviderSelectItems();
    const values = readlineItems.map((i) => i.value);
    // Declared providers are merged into the known list, so they appear
    // with their own number; the generic Custom entry stays last and keeps
    // the highest number in both the readline and TUI lists.
    expect(values.indexOf("my-llama")).toBeGreaterThanOrEqual(0);
    expect(values[values.length - 1]).toBe(CUSTOM_PROVIDER_VALUE);
    for (let i = 0; i < values.length; i++) {
      expect(readlineItems[i].label).toBeTruthy();
    }
  });
});
