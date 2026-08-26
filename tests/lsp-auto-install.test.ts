/**
 * Tests for zero-config LSP auto-activation, default registry, and auto-downloading.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  languageFromPath,
  lspLanguageId,
  resolveServerArgv,
  resolveServerKey,
  DEFAULT_LSP_SERVERS,
  resolveOrInstallServer,
  getLspCacheDir,
  LspManager,
} from "../src/lsp/index.js";
import type { LspConfig } from "../src/types.js";

describe("LSP Language Resolution & Default Registry", () => {
  it("resolves multi-language extensions to language IDs", () => {
    expect(languageFromPath("main.ts")).toBe("typescript");
    expect(languageFromPath("component.tsx")).toBe("typescript");
    expect(languageFromPath("index.js")).toBe("javascript");
    expect(languageFromPath("script.mjs")).toBe("javascript");
    expect(languageFromPath("server.py")).toBe("python");
    expect(languageFromPath("types.pyi")).toBe("python");
    expect(languageFromPath("main.go")).toBe("go");
    expect(languageFromPath("lib.rs")).toBe("rust");
    expect(languageFromPath("package.json")).toBe("json");
    expect(languageFromPath("tsconfig.jsonc")).toBe("json");
    expect(languageFromPath("index.html")).toBe("html");
    expect(languageFromPath("style.css")).toBe("css");
    expect(languageFromPath("config.yaml")).toBe("yaml");
    expect(languageFromPath("workflow.yml")).toBe("yaml");
    expect(languageFromPath("praana.config.toml")).toBe("toml");
    expect(languageFromPath("unknown.xyz")).toBeNull();
  });

  it("normalizes language IDs for didOpen", () => {
    expect(lspLanguageId("typescript")).toBe("typescript");
    expect(lspLanguageId("javascript")).toBe("javascript");
    expect(lspLanguageId("python")).toBe("python");
    expect(lspLanguageId("go")).toBe("go");
    expect(lspLanguageId("rust")).toBe("rust");
    expect(lspLanguageId("json")).toBe("json");
    expect(lspLanguageId("html")).toBe("html");
    expect(lspLanguageId("css")).toBe("css");
    expect(lspLanguageId("yaml")).toBe("yaml");
    expect(lspLanguageId("toml")).toBe("toml");
  });

  it("resolves default server specs when config.servers is empty", () => {
    const servers: Record<string, string[]> = {};
    expect(resolveServerKey("typescript", servers)).toBe("typescript");
    expect(resolveServerKey("javascript", servers)).toBe("typescript");
    expect(resolveServerKey("python", servers)).toBe("python");
    expect(resolveServerKey("go", servers)).toBe("go");
    expect(resolveServerKey("rust", servers)).toBe("rust");
    expect(resolveServerKey("yaml", servers)).toBe("yaml");
    expect(resolveServerKey("toml", servers)).toBe("toml");

    expect(resolveServerArgv("typescript", servers)).toEqual([
      "typescript-language-server",
      "--stdio",
    ]);
    expect(resolveServerArgv("javascript", servers)).toEqual([
      "typescript-language-server",
      "--stdio",
    ]);
    expect(resolveServerArgv("python", servers)).toEqual([
      "pyright-langserver",
      "--stdio",
    ]);
    expect(resolveServerArgv("go", servers)).toEqual(["gopls"]);
    expect(resolveServerArgv("rust", servers)).toEqual(["rust-analyzer"]);
    expect(resolveServerArgv("yaml", servers)).toEqual([
      "yaml-language-server",
      "--stdio",
    ]);
    expect(resolveServerArgv("toml", servers)).toEqual(["taplo", "lsp", "stdio"]);
  });

  it("prioritizes explicit user config over default registry", () => {
    const servers: Record<string, string[]> = {
      typescript: ["vtsls", "--stdio"],
      python: ["basedpyright-langserver", "--stdio"],
    };
    expect(resolveServerArgv("typescript", servers)).toEqual([
      "vtsls",
      "--stdio",
    ]);
    expect(resolveServerArgv("javascript", servers)).toEqual([
      "vtsls",
      "--stdio",
    ]);
    expect(resolveServerArgv("python", servers)).toEqual([
      "basedpyright-langserver",
      "--stdio",
    ]);
    expect(resolveServerArgv("go", servers)).toEqual(["gopls"]);
  });
});

describe("LSP Auto-Installer & Resolver", () => {
  let testCacheDir: string;
  const baseConfig: LspConfig = {
    enabled: true,
    diagnostics: true,
    format_on_edit: false,
    timeout_ms: 5000,
    max_file_lines: 10_000,
    servers: {},
    auto_install: true,
  };

  beforeEach(() => {
    testCacheDir = join(
      tmpdir(),
      `praana-lsp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testCacheDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testCacheDir, { recursive: true, force: true });
  });

  it("returns explicit user config without checking disk or downloading", async () => {
    const config: LspConfig = {
      ...baseConfig,
      servers: {
        typescript: ["my-custom-tsserver", "--stdio"],
      },
    };

    const res = await resolveOrInstallServer("typescript", {
      config,
      lspCacheDir: testCacheDir,
    });
    expect(res).toEqual(["my-custom-tsserver", "--stdio"]);
  });

  it("resolves cached binary from lsp directory when available", async () => {
    const originalSpec = DEFAULT_LSP_SERVERS.typescript;
    const fakeBinName = "non-system-lsp-bin-555";
    DEFAULT_LSP_SERVERS.typescript = {
      binary: fakeBinName,
      args: ["--stdio"],
    };

    const binDir = join(testCacheDir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const fakeBin = join(binDir, fakeBinName);
    writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");

    try {
      const res = await resolveOrInstallServer("typescript", {
        config: baseConfig,
        lspCacheDir: testCacheDir,
      });
      expect(res).toEqual([fakeBin, "--stdio"]);
    } finally {
      DEFAULT_LSP_SERVERS.typescript = originalSpec;
    }
  });

  it("returns null when binary is missing and auto_install is false", async () => {
    const config: LspConfig = {
      ...baseConfig,
      auto_install: false,
    };

    // Use a custom spec that is guaranteed not on PATH
    const originalSpec = DEFAULT_LSP_SERVERS.typescript;
    DEFAULT_LSP_SERVERS.typescript = {
      binary: "nonexistent-lsp-binary-12345",
      args: ["--stdio"],
    };

    try {
      const res = await resolveOrInstallServer("typescript", {
        config,
        lspCacheDir: testCacheDir,
      });
      expect(res).toBeNull();
    } finally {
      DEFAULT_LSP_SERVERS.typescript = originalSpec;
    }
  });

  it("invokes installFn when binary is missing and auto_install is true", async () => {
    const originalSpec = DEFAULT_LSP_SERVERS.python;
    const fakeBinName = "fake-pyright-bin-999";
    DEFAULT_LSP_SERVERS.python = {
      binary: fakeBinName,
      args: ["--stdio"],
      npmPackages: ["pyright"],
    };

    const mockInstall = mock(async (_spec, cacheDir) => {
      const installed = join(cacheDir, fakeBinName);
      writeFileSync(installed, "");
      return installed;
    });

    try {
      const res = await resolveOrInstallServer("python", {
        config: baseConfig,
        lspCacheDir: testCacheDir,
        installFn: mockInstall,
      });

      expect(mockInstall).toHaveBeenCalledTimes(1);
      expect(res).toEqual([join(testCacheDir, fakeBinName), "--stdio"]);
    } finally {
      DEFAULT_LSP_SERVERS.python = originalSpec;
    }
  });

  it("deduplicates concurrent install calls for the same language", async () => {
    const originalSpec = DEFAULT_LSP_SERVERS.python;
    const fakeBinName = "fake-concurrent-pyright";
    DEFAULT_LSP_SERVERS.python = {
      binary: fakeBinName,
      args: ["--stdio"],
      npmPackages: ["pyright"],
    };

    let callCount = 0;
    const mockInstall = mock(async (_spec, cacheDir) => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return join(cacheDir, fakeBinName);
    });

    try {
      const [res1, res2, res3] = await Promise.all([
        resolveOrInstallServer("python", {
          config: baseConfig,
          lspCacheDir: testCacheDir,
          installFn: mockInstall,
        }),
        resolveOrInstallServer("python", {
          config: baseConfig,
          lspCacheDir: testCacheDir,
          installFn: mockInstall,
        }),
        resolveOrInstallServer("python", {
          config: baseConfig,
          lspCacheDir: testCacheDir,
          installFn: mockInstall,
        }),
      ]);

      expect(callCount).toBe(1);
      expect(res1).toEqual([join(testCacheDir, fakeBinName), "--stdio"]);
      expect(res2).toEqual(res1);
      expect(res3).toEqual(res1);
    } finally {
      DEFAULT_LSP_SERVERS.python = originalSpec;
    }
  });
});

describe("LspManager with Zero-Config Auto-Resolution", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `praana-lsp-mgr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("spawns client using auto-resolved server when config.servers is empty", async () => {
    const mockStart = mock(async (opts: any) => ({
      supportsHover: true,
      hover: mock(async () => null),
      didOpen: mock(async () => {}),
      close: mock(async () => {}),
    }));

    const mockResolver = mock(async () => ["/bin/mock-lsp", "--stdio"]);

    const mgr = new LspManager({
      config: {
        enabled: true,
        diagnostics: true,
        format_on_edit: false,
        timeout_ms: 5000,
        max_file_lines: 10000,
        servers: {},
        auto_install: true,
      },
      cwd: testDir,
      workspaceRoot: testDir,
      startClient: mockStart as any,
      resolveServer: mockResolver,
    });

    const file = join(testDir, "test.ts");
    writeFileSync(file, "const a = 1;");

    const res = await mgr.hover(file, 1, 1);
    expect(res.ok).toBe(true);
    expect(mockResolver).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart.mock.calls[0][0].command).toEqual(["/bin/mock-lsp", "--stdio"]);
  });
});
