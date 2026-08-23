import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, getConfigWarnings } from "../src/config.js";
import { createTestLogger, setAppLogger } from "../src/logger.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
let configPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "praana-verify-cfg-"));
  configPath = join(dir, "praana.config.toml");
  getConfigWarnings();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCfg(body: string) {
  writeFileSync(configPath, body, "utf-8");
}

describe("loadConfig: [verify]", () => {
  it("defaults to disabled with syntax/typecheck/tests on", () => {
    writeCfg(`[llm]\nmodel = "openai/gpt-4o-mini"\n`);
    const cfg = loadConfig(configPath);
    expect(cfg.verify).toEqual({
      enabled: false,
      syntax: true,
      typecheck: true,
      tests: true,
      timeout_ms: 30_000,
      max_test_files: 20,
    });
  });

  it("parses boolean flags and limits", () => {
    writeCfg(`
[verify]
enabled = true
syntax = false
typecheck = false
tests = false
timeout_ms = 12000
max_test_files = 5
`);
    const cfg = loadConfig(configPath);
    expect(cfg.verify?.enabled).toBe(true);
    expect(cfg.verify?.syntax).toBe(false);
    expect(cfg.verify?.typecheck).toBe(false);
    expect(cfg.verify?.tests).toBe(false);
    expect(cfg.verify?.timeout_ms).toBe(12000);
    expect(cfg.verify?.max_test_files).toBe(5);
  });

  it("warns and falls back on invalid timeout_ms and max_test_files", () => {
    const captured: string[] = [];
    setAppLogger(createTestLogger((line) => captured.push(line)));
    try {
      writeCfg(`[verify]\ntimeout_ms = -1\nmax_test_files = 0\n`);
      const cfg = loadConfig(configPath);
      expect(cfg.verify?.timeout_ms).toBe(30_000);
      expect(cfg.verify?.max_test_files).toBe(20);
      expect(captured.some((l) => l.includes("verify.timeout_ms"))).toBe(true);
      expect(captured.some((l) => l.includes("verify.max_test_files"))).toBe(
        true,
      );
    } finally {
      setAppLogger(createTestLogger(() => {}));
    }
  });
});
