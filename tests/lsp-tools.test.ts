import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLspTools } from "../src/tools/lsp.js";
import { LspManager } from "../src/lsp/manager.js";
import { createLspEditHandlers } from "../src/hooks/handlers/lsp.js";
import { PLAN_MODE_BLOCKED_TOOLS } from "../src/plan-mode.js";
import type { LspConfig } from "../src/types.js";

const fixture = join(import.meta.dirname, "fixtures", "fake-lsp-server.ts");

function cfg(over: Partial<LspConfig> = {}): LspConfig {
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

describe("lsp tools", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-lsp-tools-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("soft-fails when manager is missing", async () => {
    const tools = createLspTools({
      cwd: dir,
      getLsp: () => null,
    });
    const result = await tools.lsp_diagnostics.execute({ path: "a.ts" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unavailable");
  });

  it("returns diagnostics via fake server", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1;\n");
    const mgr = new LspManager({
      config: cfg(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        import("../src/lsp/client.js").then(({ LspClient }) =>
          LspClient.start({
            ...opts,
            env: {
              FAKE_LSP_DIAGNOSTICS: JSON.stringify([
                {
                  message: "tool diag",
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
      const tools = createLspTools({ cwd: dir, getLsp: () => mgr });
      const result = await tools.lsp_diagnostics.execute({ path: "a.ts" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.diagnostics.some((d) => d.message === "tool diag")).toBe(
          true,
        );
      }
    } finally {
      await mgr.shutdown();
    }
  });

  it("enforces sandbox on lsp_format", async () => {
    const allowed = join(dir, "ok");
    mkdirSync(allowed);
    writeFileSync(join(allowed, "a.ts"), "x\n");
    writeFileSync(join(dir, "blocked.ts"), "x\n");
    const mgr = new LspManager({
      config: cfg(),
      cwd: dir,
      workspaceRoot: dir,
    });
    try {
      const tools = createLspTools({
        cwd: dir,
        sandbox: { enabled: true, allowed_paths: [allowed] },
        getLsp: () => mgr,
      });
      const blocked = await tools.lsp_format.execute({ path: "blocked.ts" });
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toContain("sandbox");
    } finally {
      await mgr.shutdown();
    }
  });

  it("blocks lsp_format in plan mode tool set", () => {
    expect(PLAN_MODE_BLOCKED_TOOLS.has("lsp_format")).toBe(true);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("lsp_diagnostics")).toBe(false);
  });

  it("lsp_hover is 1-based and returns mapped hover", async () => {
    writeFileSync(join(dir, "a.ts"), "const n = 1;\n");
    const mgr = new LspManager({
      config: cfg(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        import("../src/lsp/client.js").then(({ LspClient }) =>
          LspClient.start({
            ...opts,
            env: {
              FAKE_LSP_HOVER: JSON.stringify({
                contents: { kind: "plaintext", value: "number" },
              }),
            },
          }),
        ),
    });
    try {
      const tools = createLspTools({ cwd: dir, getLsp: () => mgr });
      const result = await tools.lsp_hover.execute({
        path: "a.ts",
        line: 1,
        col: 7,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.hover).toEqual({ contents: "number", kind: "plaintext" });
        expect(result.line).toBe(1);
      }
    } finally {
      await mgr.shutdown();
    }
  });

  it("rejects non-positive coordinates", async () => {
    writeFileSync(join(dir, "a.ts"), "x\n");
    const mgr = new LspManager({
      config: cfg(),
      cwd: dir,
      workspaceRoot: dir,
    });
    try {
      const tools = createLspTools({ cwd: dir, getLsp: () => mgr });
      const result = await tools.lsp_hover.execute({
        path: "a.ts",
        line: 0,
        col: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_argument");
    } finally {
      await mgr.shutdown();
    }
  });

  it("blocks lsp_apply_code_action in the plan-mode set, not query tools", () => {
    expect(PLAN_MODE_BLOCKED_TOOLS.has("lsp_apply_code_action")).toBe(true);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("lsp_hover")).toBe(false);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("lsp_code_actions")).toBe(false);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("lsp_definition")).toBe(false);
  });
});

describe("lsp post-edit hooks", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-lsp-post-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("attaches introduced diagnostics after a successful edit", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1;\n");
    let call = 0;
    const mgr = new LspManager({
      config: cfg(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        import("../src/lsp/client.js").then(({ LspClient }) =>
          LspClient.start({
            ...opts,
            env: {
              // First open (snapshot) empty; subsequent publishes include a new error.
              // Fake server always publishes the same env payload — so we simulate
              // introduced by snapshotting empty manually via a stub manager path.
              FAKE_LSP_DIAGNOSTICS: JSON.stringify([
                {
                  message: "after error",
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

    // Force empty pre-snapshot by temporarily disabling diagnostics during pre
    const handlers = createLspEditHandlers({
      cwd: dir,
      getLsp: () => mgr,
    });

    const session = {
      cwd: dir,
      isPlanMode: () => false,
    };

    try {
      // Pre with diagnostics will snapshot current (after error). To test introduced,
      // clear snapshot map behavior: run pre, then replace snapshot with empty via
      // a second edit path — simpler approach: call post with mgr that had empty before.
      // Instead: snapshot then manually we rely on same diags → introduced empty.
      await handlers.pre({
        toolName: "edit_file",
        args: { path: "a.ts" },
        session,
      });
      // After pre, write a note that diagnostics are the same → introduced empty
      const post1 = await handlers.post({
        toolName: "edit_file",
        args: { path: "a.ts" },
        result: { ok: true },
        isError: false,
        session,
      });
      expect(post1?.result).toBeTruthy();
      const lsp1 = (post1?.result as { lsp?: { introduced?: unknown[] } }).lsp;
      expect(lsp1?.introduced).toEqual([]);

      // Now run post without pre (empty before) → all after diags are introduced
      call++;
      void call;
      const post2 = await handlers.post({
        toolName: "edit_file",
        args: { path: "a.ts" },
        result: { ok: true },
        isError: false,
        session,
      });
      const lsp2 = (post2?.result as { lsp?: { introduced?: Array<{ message: string }> } })
        .lsp;
      expect(lsp2?.introduced?.some((d) => d.message === "after error")).toBe(
        true,
      );
    } finally {
      await mgr.shutdown();
    }
  });
});
