import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, getConfigWarnings } from "../src/config.js";
import { createTestLogger, setAppLogger } from "../src/logger.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
let configPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "praana-lsp-cfg-"));
  configPath = join(dir, "praana.config.toml");
  getConfigWarnings(); // drain
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCfg(body: string) {
  writeFileSync(configPath, body, "utf-8");
}

describe("loadConfig: [lsp]", () => {
  it("defaults to disabled with diagnostics on and format_on_edit off", () => {
    writeCfg(`[llm]\nmodel = "openai/gpt-4o-mini"\n`);
    const cfg = loadConfig(configPath);
    expect(cfg.lsp).toEqual({
      enabled: false,
      diagnostics: true,
      format_on_edit: false,
      timeout_ms: 5000,
      max_file_lines: 10_000,
      servers: {},
    });
  });

  it("parses servers argv arrays and boolean flags", () => {
    writeCfg(`
[lsp]
enabled = true
diagnostics = false
format_on_edit = true
timeout_ms = 8000
max_file_lines = 2000

[lsp.servers]
typescript = ["typescript-language-server", "--stdio"]
`);
    const cfg = loadConfig(configPath);
    expect(cfg.lsp?.enabled).toBe(true);
    expect(cfg.lsp?.diagnostics).toBe(false);
    expect(cfg.lsp?.format_on_edit).toBe(true);
    expect(cfg.lsp?.timeout_ms).toBe(8000);
    expect(cfg.lsp?.max_file_lines).toBe(2000);
    expect(cfg.lsp?.servers.typescript).toEqual([
      "typescript-language-server",
      "--stdio",
    ]);
  });

  it("warns and falls back on invalid timeout_ms", () => {
    const captured: string[] = [];
    setAppLogger(createTestLogger((line) => captured.push(line)));
    try {
      writeCfg(`[lsp]\ntimeout_ms = -1\n`);
      const cfg = loadConfig(configPath);
      expect(cfg.lsp?.timeout_ms).toBe(5000);
      expect(captured.some((l) => l.includes("lsp.timeout_ms"))).toBe(true);
    } finally {
      setAppLogger(createTestLogger(() => {}));
    }
  });

  it("warns and ignores malformed server argv", () => {
    const captured: string[] = [];
    setAppLogger(createTestLogger((line) => captured.push(line)));
    try {
      writeCfg(`
[lsp]
enabled = true

[lsp.servers]
typescript = "typescript-language-server --stdio"
python = ["pyright-langserver", "--stdio"]
`);
      const cfg = loadConfig(configPath);
      expect(cfg.lsp?.servers.typescript).toBeUndefined();
      expect(cfg.lsp?.servers.python).toEqual([
        "pyright-langserver",
        "--stdio",
      ]);
      expect(captured.some((l) => l.includes("lsp.servers.typescript"))).toBe(
        true,
      );
    } finally {
      setAppLogger(createTestLogger(() => {}));
    }
  });
});
