import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBuiltinHookRegistry } from "../src/hooks/index.js";
import type { HookSessionLike } from "../src/hooks/types.js";
import {
  createVerifyPostToolCallHandler,
  shouldRemember,
} from "../src/hooks/handlers/verify.js";
import type { VerifyConfig } from "../src/types.js";
import type { ParseFileResult } from "../src/native/types.js";
import type { VerifyPayload } from "../src/verify/types.js";

function fakeSession(cwd: string): HookSessionLike {
  return { cwd, isPlanMode: () => false };
}

function enabledConfig(overrides?: Partial<VerifyConfig>): VerifyConfig {
  return {
    enabled: true,
    syntax: true,
    typecheck: true,
    tests: true,
    timeout_ms: 5_000,
    max_test_files: 20,
    ...overrides,
  };
}

function parseOk(diagnostics: ParseFileResult["diagnostics"] = []): ParseFileResult {
  return { ok: true, language: "typescript", diagnostics };
}

describe("createVerifyPostToolCallHandler", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-vh-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    file = join(dir, "a.ts");
    writeFileSync(file, "export const n = 1;\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the result unchanged when verify is disabled", async () => {
    const handler = createVerifyPostToolCallHandler({
      cwd: dir,
      getConfig: () => enabledConfig({ enabled: false }),
      parseFile: () => parseOk([{ message: "x", startLine: 1, startCol: 1, endLine: 1, endCol: 1 }]),
    });
    const original = { ok: true };
    const patch = await handler({
      toolName: "write_file",
      args: { path: file, content: "x" },
      result: original,
      isError: false,
      session: fakeSession(dir),
    });
    expect(patch).toBeUndefined();
  });

  it("skips lsp_format and lsp_apply_code_action", async () => {
    const handler = createVerifyPostToolCallHandler({
      cwd: dir,
      getConfig: () => enabledConfig(),
      parseFile: () => {
        throw new Error("should not parse");
      },
    });
    for (const toolName of ["lsp_format", "lsp_apply_code_action"]) {
      const patch = await handler({
        toolName,
        args: { path: file },
        result: { ok: true },
        isError: false,
        session: fakeSession(dir),
      });
      expect(patch).toBeUndefined();
    }
  });

  it("attaches syntax errors and skips tests", async () => {
    const handler = createVerifyPostToolCallHandler({
      cwd: dir,
      getConfig: () => enabledConfig(),
      parseFile: () =>
        parseOk([
          {
            message: "missing }",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 2,
          },
        ]),
      runTypecheck: async () => ({ stdout: "", stderr: "", code: 0 }),
      runTests: async () => {
        throw new Error("tests should not run");
      },
    });
    const patch = await handler({
      toolName: "edit_file",
      args: { path: file },
      result: { ok: true },
      isError: false,
      session: fakeSession(dir),
    });
    const verify = (patch?.result as { verify: VerifyPayload }).verify;
    expect(verify.syntax?.diagnostics).toHaveLength(1);
    expect(verify.tests?.skipped).toBe("errors_present");
    expect((patch?.result as { ok: boolean }).ok).toBe(true);
  });

  it("attaches typecheck errors and skips tests", async () => {
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const handler = createVerifyPostToolCallHandler({
      cwd: dir,
      getConfig: () => enabledConfig({ syntax: false }),
      runTypecheck: async () => ({
        stdout: "",
        stderr: "a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n",
        code: 2,
      }),
      runTests: async () => {
        throw new Error("tests should not run");
      },
    });
    const patch = await handler({
      toolName: "write_file",
      args: { path: "a.ts" },
      result: { ok: true },
      isError: false,
      session: fakeSession(dir),
    });
    const verify = (patch?.result as { verify: VerifyPayload }).verify;
    expect(verify.typecheck?.errors).toHaveLength(1);
    expect(verify.tests?.skipped).toBe("errors_present");
  });

  it("returns cached=true on an unchanged hash after a clean verify", async () => {
    const handler = createVerifyPostToolCallHandler({
      cwd: dir,
      getConfig: () => enabledConfig(),
      parseFile: () => parseOk(),
      runTypecheck: async () => ({ stdout: "", stderr: "", code: 0 }),
      listImports: () => ({
        ok: true,
        language: "typescript",
        imports: [],
      }),
      runTests: async () => ({ passed: 1, failed: 0, files: [], failures: [] }),
    });
    const ctx = {
      toolName: "write_file" as const,
      args: { path: file },
      result: { ok: true },
      isError: false,
      session: fakeSession(dir),
    };
    const first = await handler(ctx);
    const firstVerify = (first?.result as { verify: VerifyPayload }).verify;
    expect(firstVerify.cached).toBeUndefined();
    expect(firstVerify.tests?.skipped).toBe("none_affected");

    const second = await handler(ctx);
    expect((second?.result as { verify: VerifyPayload }).verify).toEqual({
      cached: true,
    });
  });

  it("does not cache after a typecheck timeout", async () => {
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const handler = createVerifyPostToolCallHandler({
      cwd: dir,
      getConfig: () => enabledConfig({ syntax: false }),
      runTypecheck: async () => {
        throw new Error("timed out after 5000ms");
      },
      runTests: async () => {
        throw new Error("tests should not run");
      },
    });
    const ctx = {
      toolName: "write_file" as const,
      args: { path: file },
      result: { ok: true },
      isError: false,
      session: fakeSession(dir),
    };
    const first = await handler(ctx);
    const verify = (first?.result as { verify: VerifyPayload }).verify;
    expect(verify.typecheck?.skipped).toBe("timeout");
    expect(verify.tests?.skipped).toBe("timeout");
    expect(shouldRemember(verify)).toBe(false);

    const second = await handler(ctx);
    expect((second?.result as { verify: VerifyPayload }).verify.cached).toBeUndefined();
  });

  it("runs scoped tsc once per tsconfig for batch writes", async () => {
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "b.ts"), "export {};\n");
    let calls = 0;
    const handler = createVerifyPostToolCallHandler({
      cwd: dir,
      getConfig: () => enabledConfig({ syntax: false, tests: false }),
      runTypecheck: async () => {
        calls += 1;
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    await handler({
      toolName: "batch_write",
      args: {
        files: [
          { path: "a.ts", content: "x" },
          { path: "b.ts", content: "y" },
        ],
      },
      result: { ok: true },
      isError: false,
      session: fakeSession(dir),
    });
    expect(calls).toBe(1);
  });

  it("does not flip ok when verification finds failures", async () => {
    const testFile = join(dir, "a.test.ts");
    writeFileSync(testFile, 'import "./a.js";\n');
    const handler = createVerifyPostToolCallHandler({
      cwd: dir,
      getConfig: () => enabledConfig({ syntax: false, typecheck: false }),
      listImports: (path) =>
        path === testFile
          ? {
              ok: true,
              language: "typescript",
              imports: [
                {
                  path: "",
                  source: "./a.js",
                  names: [],
                  startLine: 1,
                  startCol: 1,
                  endLine: 1,
                  endCol: 1,
                },
              ],
            }
          : { ok: true, language: "typescript", imports: [] },
      runTests: async (files) => ({
        passed: 0,
        failed: 1,
        files,
        failures: [{ name: "breaks", file: files[0] ?? "", message: "nope" }],
      }),
    });
    const patch = await handler({
      toolName: "batch_edit",
      args: { edits: [{ path: "a.ts" }] },
      result: { ok: true },
      isError: false,
      session: fakeSession(dir),
    });
    const result = patch?.result as { ok: boolean; verify: VerifyPayload };
    expect(result.ok).toBe(true);
    expect(result.verify.tests?.failed).toBe(1);
    expect(result.verify.tests?.files).toEqual([testFile]);
  });
});

describe("builtin registry: verify disabled by default", () => {
  it("does not attach verify when config is omitted", async () => {
    const dir = join(
      tmpdir(),
      `praana-vh2-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "a.ts");
    writeFileSync(file, "export {};\n");
    try {
      const registry = createBuiltinHookRegistry(dir);
      const out = await registry.runPostToolCall({
        toolName: "write_file",
        args: { path: file, content: "x" },
        result: { ok: true },
        isError: false,
        session: fakeSession(dir),
      });
      expect(out.result).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
