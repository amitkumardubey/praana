import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  getConfigWarnings,
  getLoadedConfigSources,
} from "../src/config.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";

describe("config loading", () => {
  let root: string;
  let logLines: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "praana-config-test-"));
    logLines = [];
    setAppLogger(
      new PraanaLogger({ domain: "app", writeLine: (line) => logLines.push(line) }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("captures parser warnings and includes CONFIG_INVALID in logs", () => {
    const configPath = join(root, "config.toml");
    writeFileSync(configPath, "[llm\nprovider = \"openrouter\"\n", "utf-8");

    loadConfig(configPath);
    const warnings = getConfigWarnings();

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("Failed to parse TOML"))).toBe(true);
    expect(getLoadedConfigSources()).toHaveLength(0);
    expect(logLines.some((l) => l.includes("CONFIG_INVALID"))).toBe(true);
  });

  it("parses fallback_provider and fallback_model under [llm]", () => {
    const configPath = join(root, "fallback.toml");
    writeFileSync(
      configPath,
      '[llm]\nprovider = "umans"\nmodel = "umans-coder"\nfallback_provider = "openrouter"\nfallback_model = "moonshotai/kimi-k2.7-code"\n',
      "utf-8",
    );

    const config = loadConfig(configPath);
    expect(config.llm.fallback_provider).toBe("openrouter");
    expect(config.llm.fallback_model).toBe("moonshotai/kimi-k2.7-code");
    expect(getConfigWarnings()).toHaveLength(0);
  });

  it("warnings reflect the most recent loadConfig() call", () => {
    const goodConfig = join(root, "good.toml");
    const badConfig = join(root, "bad.toml");
    writeFileSync(goodConfig, '[llm]\nprovider = "openrouter"\nmodel = "m"\n', "utf-8");
    writeFileSync(badConfig, "[llm\n", "utf-8");

    loadConfig(goodConfig);
    expect(getConfigWarnings()).toHaveLength(0);

    loadConfig(badConfig);
    const warnings = getConfigWarnings();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("Failed to parse TOML"))).toBe(true);
  });
});
