import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LspManager, diffIntroduced } from "../src/lsp/manager.js";
import { LspClient } from "../src/lsp/client.js";
import { applyTextEdits } from "../src/lsp/edits.js";
import {
  languageFromPath,
  resolveServerArgv,
  resolveServerKey,
} from "../src/lsp/language.js";
import { pathToFileUri } from "../src/lsp/types.js";
import type { LspConfig } from "../src/types.js";
import type { LspDiagnostic } from "../src/lsp/types.js";

const fixture = join(import.meta.dirname, "fixtures", "fake-lsp-server.ts");

function baseConfig(over: Partial<LspConfig> = {}): LspConfig {
  return {
    enabled: true,
    diagnostics: true,
    format_on_edit: false,
    timeout_ms: 3000,
    max_file_lines: 10_000,
    servers: {
      typescript: [process.execPath, "run", fixture],
    },
    ...over,
  };
}

describe("language helpers", () => {
  it("maps TS/JS extensions", () => {
    expect(languageFromPath("a.ts")).toBe("typescript");
    expect(languageFromPath("a.tsx")).toBe("typescript");
    expect(languageFromPath("a.js")).toBe("javascript");
    expect(languageFromPath("a.py")).toBeNull();
  });

  it("falls back javascript → typescript server", () => {
    expect(
      resolveServerArgv("javascript", {
        typescript: ["typescript-language-server", "--stdio"],
      }),
    ).toEqual(["typescript-language-server", "--stdio"]);
    expect(
      resolveServerKey("javascript", {
        typescript: ["typescript-language-server", "--stdio"],
      }),
    ).toBe("typescript");
    expect(
      resolveServerKey("javascript", {
        javascript: ["js-server"],
        typescript: ["ts-server"],
      }),
    ).toBe("javascript");
  });
});

describe("applyTextEdits", () => {
  it("applies non-overlapping edits from end to start", () => {
    const result = applyTextEdits("abcdef", [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        newText: "A",
      },
      {
        range: { start: { line: 0, character: 3 }, end: { line: 0, character: 4 } },
        newText: "D",
      },
    ]);
    expect(result).toEqual({ ok: true, content: "AbcDef" });
  });

  it("rejects overlapping edits", () => {
    const result = applyTextEdits("abcdef", [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        newText: "X",
      },
      {
        range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } },
        newText: "Y",
      },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("diffIntroduced", () => {
  it("returns only new diagnostics", () => {
    const before: LspDiagnostic[] = [
      {
        path: "/a.ts",
        message: "old",
        severity: "error",
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 2,
      },
    ];
    const after: LspDiagnostic[] = [
      ...before,
      {
        path: "/a.ts",
        message: "new",
        severity: "error",
        startLine: 2,
        startCol: 1,
        endLine: 2,
        endCol: 2,
      },
    ];
    expect(diffIntroduced(before, after).map((d) => d.message)).toEqual([
      "new",
    ]);
  });
});

describe("LspManager", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-lsp-mgr-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not spawn when disabled", async () => {
    const mgr = new LspManager({
      config: baseConfig({ enabled: false }),
      cwd: dir,
      workspaceRoot: dir,
    });
    const result = await mgr.diagnostics(join(dir, "x.ts"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("disabled");
    await mgr.shutdown();
  });

  it("reuses one client and returns diagnostics", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1;\n");
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        import("../src/lsp/client.js").then(({ LspClient }) =>
          LspClient.start({
            ...opts,
            env: {
              FAKE_LSP_DIAGNOSTICS: JSON.stringify([
                {
                  message: "mgr error",
                  severity: 1,
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 },
                  },
                },
              ]),
            },
          }),
        ),
    });

    try {
      const a = await mgr.diagnostics(join(dir, "a.ts"));
      expect(a.ok).toBe(true);
      if (a.ok) {
        expect(a.value.some((d) => d.message === "mgr error")).toBe(true);
      }
      const b = await mgr.diagnostics(join(dir, "a.ts"));
      expect(b.ok).toBe(true);
    } finally {
      await mgr.shutdown();
    }
  });

  it("formats a file when the server returns edits", async () => {
    const path = join(dir, "b.ts");
    writeFileSync(path, "x\n");
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        import("../src/lsp/client.js").then(({ LspClient }) =>
          LspClient.start({
            ...opts,
            env: {
              FAKE_LSP_EDITS: JSON.stringify([
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                  },
                  newText: "// ok\n",
                },
              ]),
            },
          }),
        ),
    });

    try {
      const result = await mgr.format(path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.changed).toBe(true);
      }
      const text = await Bun.file(path).text();
      expect(text.startsWith("// ok\n")).toBe(true);
    } finally {
      await mgr.shutdown();
    }
  });

  it("waits for asynchronously published diagnostics", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1;\n");
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        import("../src/lsp/client.js").then(({ LspClient }) =>
          LspClient.start({
            ...opts,
            env: {
              FAKE_LSP_PUBLISH_DELAY_MS: "150",
              FAKE_LSP_DIAGNOSTICS: JSON.stringify([
                {
                  message: "async error",
                  severity: 1,
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 },
                  },
                },
              ]),
            },
          }),
        ),
    });

    try {
      const a = await mgr.diagnostics(join(dir, "a.ts"));
      expect(a.ok).toBe(true);
      if (a.ok) {
        expect(a.value.some((d) => d.message === "async error")).toBe(true);
      }
    } finally {
      await mgr.shutdown();
    }
  });
});

describe("Phase 3 queries", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-lsp-p3-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns hover via fake server", async () => {
    writeFileSync(join(dir, "a.ts"), "const n = 1;\n");
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        LspClient.start({
          ...opts,
          env: {
            FAKE_LSP_HOVER: JSON.stringify({
              contents: { kind: "plaintext", value: "n: number" },
            }),
          },
        }),
    });
    try {
      const result = await mgr.hover(join(dir, "a.ts"), 1, 7);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toBeUndefined();
        expect(result.value.hover).toEqual({
          contents: "n: number",
          kind: "plaintext",
        });
      }
    } finally {
      await mgr.shutdown();
    }
  });

  it("skips hover when capability is off", async () => {
    writeFileSync(join(dir, "a.ts"), "x\n");
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        LspClient.start({ ...opts, env: { FAKE_LSP_NO_HOVER: "1" } }),
    });
    try {
      const result = await mgr.hover(join(dir, "a.ts"), 1, 1);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.skipped).toBe("unsupported");
    } finally {
      await mgr.shutdown();
    }
  });

  it("lists applicable actions with opaque ids and applies text edits", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "x\n");
    const uri = pathToFileUri(path);
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        LspClient.start({
          ...opts,
          env: {
            FAKE_LSP_CODE_ACTIONS: JSON.stringify([
              {
                title: "Add comment",
                kind: "quickfix",
                edit: {
                  changes: {
                    [uri]: [
                      {
                        range: {
                          start: { line: 0, character: 0 },
                          end: { line: 0, character: 0 },
                        },
                        newText: "// ok\n",
                      },
                    ],
                  },
                },
              },
              { title: "Command only", command: "do.it" },
            ]),
          },
        }),
    });
    try {
      const listed = await mgr.codeActions(path, 1, 1, 1, 1);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.actions).toHaveLength(1);
      expect(listed.value.actions[0]?.title).toBe("Add comment");
      expect(listed.value.actions[0]?.id).toMatch(/^ca_\d+$/);

      const applied = await mgr.applyCodeAction(listed.value.actions[0]!.id);
      expect(applied.ok).toBe(true);
      if (applied.ok) expect(applied.value.changed).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("// ok\nx\n");
    } finally {
      await mgr.shutdown();
    }
  });

  it("rejects stale ids after the file changes", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "x\n");
    const uri = pathToFileUri(path);
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        LspClient.start({
          ...opts,
          env: {
            FAKE_LSP_CODE_ACTIONS: JSON.stringify([
              {
                title: "noop",
                edit: { changes: { [uri]: [] } },
              },
            ]),
          },
        }),
    });
    try {
      const listed = await mgr.codeActions(path, 1, 1, 1, 1);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      writeFileSync(path, "changed\n");
      const applied = await mgr.applyCodeAction(listed.value.actions[0]!.id);
      expect(applied.ok).toBe(false);
      if (!applied.ok) expect(applied.code).toBe("invalid_argument");
    } finally {
      await mgr.shutdown();
    }
  });

  it("rejects resource-op workspace edits without writing", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "x\n");
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        LspClient.start({
          ...opts,
          env: {
            FAKE_LSP_RESOLVE: "1",
            FAKE_LSP_CODE_ACTIONS: JSON.stringify([
              { title: "Extract file", data: { id: 1 } },
            ]),
            FAKE_LSP_RESOLVED_EDIT: JSON.stringify({
              documentChanges: [
                { kind: "create", uri: pathToFileUri(join(dir, "b.ts")) },
              ],
            }),
          },
        }),
    });
    try {
      const listed = await mgr.codeActions(path, 1, 1, 1, 1);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const applied = await mgr.applyCodeAction(listed.value.actions[0]!.id);
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(applied.value.skipped).toBe("unsupported");
        expect(applied.value.changed).toBe(false);
      }
      expect(existsSync(join(dir, "b.ts"))).toBe(false);
    } finally {
      await mgr.shutdown();
    }
  });
});

describe("LspManager Phase 4 restart + multi-root", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-lsp-p4-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const skipBackoff = { sleep: async () => {} };

  it("retries a crashed hover on the same call", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "const n = 1;\n");
    let starts = 0;
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      ...skipBackoff,
      startClient: (opts) => {
        starts++;
        return LspClient.start({
          ...opts,
          env: starts === 1 ? { FAKE_LSP_EXIT_ON: "textDocument/hover" } : {},
        });
      },
    });
    try {
      const result = await mgr.hover(path, 1, 1);
      expect(result.ok).toBe(true);
      expect(starts).toBe(2);
    } finally {
      await mgr.shutdown();
    }
  });

  it("returns unavailable after 3 restarts", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "const n = 1;\n");
    let starts = 0;
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      ...skipBackoff,
      startClient: (opts) => {
        starts++;
        return LspClient.start({
          ...opts,
          env: { FAKE_LSP_EXIT_ON: "textDocument/hover" },
        });
      },
    });
    try {
      for (let i = 0; i < 6; i++) {
        await mgr.hover(path, 1, 1);
      }
      const last = await mgr.hover(path, 1, 1);
      expect(last.ok).toBe(false);
      if (!last.ok) expect(last.code).toBe("unavailable");
      expect(starts).toBeLessThanOrEqual(4);
    } finally {
      await mgr.shutdown();
    }
  });

  it("does not count a timeout as a restart", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "const n = 1;\n");
    let starts = 0;
    const mgr = new LspManager({
      config: baseConfig({ timeout_ms: 80 }),
      cwd: dir,
      workspaceRoot: dir,
      ...skipBackoff,
      startClient: (opts) => {
        starts++;
        return LspClient.start({
          ...opts,
          timeoutMs: 80,
          env: { FAKE_LSP_DELAY_MS: "400" },
        });
      },
    });
    try {
      const timedOut = await mgr.hover(path, 1, 1);
      expect(timedOut.ok).toBe(false);
      if (!timedOut.ok) expect(timedOut.code).toBe("timeout");
      expect(starts).toBe(1);
    } finally {
      await mgr.shutdown();
    }
  });

  it("spawns a client per workspace package rootUri", async () => {
    mkdirSync(join(dir, "packages", "core"), { recursive: true });
    mkdirSync(join(dir, "packages", "cli"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    writeFileSync(join(dir, "packages", "core", "package.json"), "{}");
    writeFileSync(join(dir, "packages", "cli", "package.json"), "{}");
    const coreFile = join(dir, "packages", "core", "a.ts");
    const cliFile = join(dir, "packages", "cli", "b.ts");
    writeFileSync(coreFile, "export {};\n");
    writeFileSync(cliFile, "export {};\n");

    const rootUris: string[] = [];
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) => {
        rootUris.push(opts.rootUri);
        return LspClient.start(opts);
      },
    });
    try {
      expect((await mgr.hover(coreFile, 1, 1)).ok).toBe(true);
      expect((await mgr.hover(cliFile, 1, 1)).ok).toBe(true);
      expect(new Set(rootUris).size).toBe(2);
      expect(rootUris.some((u) => u.includes("packages/core"))).toBe(true);
      expect(rootUris.some((u) => u.includes("packages/cli"))).toBe(true);
    } finally {
      await mgr.shutdown();
    }
  });

  it("re-opens known docs after restart", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "const n = 1;\n");
    const log = join(dir, "events.jsonl");
    let starts = 0;
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      ...skipBackoff,
      startClient: (opts) => {
        starts++;
        return LspClient.start({
          ...opts,
          env: {
            FAKE_LSP_EVENT_LOG: log,
            ...(starts === 1 ? { FAKE_LSP_EXIT_ON: "textDocument/hover" } : {}),
          },
        });
      },
    });
    try {
      const result = await mgr.hover(path, 1, 1);
      expect(result.ok).toBe(true);
      const lines = readFileSync(log, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { method: string });
      const opens = lines.filter((l) => l.method === "textDocument/didOpen");
      expect(opens.length).toBeGreaterThanOrEqual(2);
    } finally {
      await mgr.shutdown();
    }
  });

  it("invalidates cached code actions after a crash restart", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "x\n");
    let starts = 0;
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      ...skipBackoff,
      startClient: (opts) => {
        starts++;
        return LspClient.start({
          ...opts,
          env: {
            FAKE_LSP_CODE_ACTIONS: JSON.stringify([
              {
                title: "Fix",
                edit: {
                  changes: {
                    [pathToFileUri(path)]: [
                      {
                        range: {
                          start: { line: 0, character: 0 },
                          end: { line: 0, character: 1 },
                        },
                        newText: "y",
                      },
                    ],
                  },
                },
              },
            ]),
            ...(starts === 1 ? { FAKE_LSP_EXIT_ON: "textDocument/hover" } : {}),
          },
        });
      },
    });
    try {
      const listed = await mgr.codeActions(path, 1, 1, 1, 1);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const id = listed.value.actions[0]!.id;
      const hover = await mgr.hover(path, 1, 1);
      expect(hover.ok).toBe(true);
      const applied = await mgr.applyCodeAction(id);
      expect(applied.ok).toBe(false);
      if (!applied.ok) expect(applied.code).toBe("invalid_argument");
    } finally {
      await mgr.shutdown();
    }
  });

  it("shares one process for JS when it falls back to the typescript server", async () => {
    const ts = join(dir, "a.ts");
    const js = join(dir, "a.js");
    writeFileSync(ts, "export {};\n");
    writeFileSync(js, "export {};\n");
    let starts = 0;
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) => {
        starts++;
        return LspClient.start(opts);
      },
    });
    try {
      expect((await mgr.hover(ts, 1, 1)).ok).toBe(true);
      expect((await mgr.hover(js, 1, 1)).ok).toBe(true);
      expect(starts).toBe(1);
    } finally {
      await mgr.shutdown();
    }
  });

  it("evicts the least-recently-used idle client when over maxClients", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    const files: string[] = [];
    for (const name of ["one", "two", "three"]) {
      const pkg = join(dir, "packages", name);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), "{}");
      const file = join(pkg, "a.ts");
      writeFileSync(file, "export {};\n");
      files.push(file);
    }
    const started: LspClient[] = [];
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      maxClients: 2,
      startClient: async (opts) => {
        const client = await LspClient.start(opts);
        started.push(client);
        return client;
      },
    });
    try {
      for (const file of files) {
        expect((await mgr.hover(file, 1, 1)).ok).toBe(true);
      }
      expect(started.length).toBe(3);
      expect(started.filter((c) => c.isClosed).length).toBeGreaterThanOrEqual(1);
    } finally {
      await mgr.shutdown();
    }
  });

  it("does not restart after shutdown", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "const n = 1;\n");
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      ...skipBackoff,
    });
    await mgr.shutdown();
    const result = await mgr.hover(path, 1, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unavailable");
  });
});
