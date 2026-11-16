import { describe, expect, it } from "bun:test";
import { createBuiltinHookRegistry } from "../src/hooks/index.js";
import { createRedactPostToolCallHandler } from "../src/hooks/handlers/redact.js";
import type { HookSessionLike } from "../src/hooks/types.js";

function session(cwd = "/proj"): HookSessionLike {
  return { cwd, isPlanMode: () => false };
}

describe("redact post_tool_call", () => {
  it("redacts strings on the result and keeps ok", async () => {
    const post = createRedactPostToolCallHandler();
    const patch = await post({
      toolName: "shell",
      args: {},
      result: { ok: true, stdout: "AKIAIOSFODNN7EXAMPLE" },
      isError: false,
      session: session(),
    });
    expect(patch?.result).toEqual({
      ok: true,
      stdout: "[REDACTED:aws-access-key]",
    });
    expect(patch?.isError).toBeUndefined();
  });

  it("runs after enrich so suggestions are scanned", async () => {
    const registry = createBuiltinHookRegistry("/proj", {
      validate: { pathExists: () => false, listRepoFiles: () => [] },
    });
    const out = await registry.runPostToolCall({
      toolName: "write_file",
      args: { path: "a.ts" },
      result: {
        ok: false,
        error: "denied AKIAIOSFODNN7EXAMPLE",
        suggestions: ["AKIAIOSFODNN7EXAMPLE"],
      },
      isError: true,
      session: session(),
    });
    expect(out.isError).toBe(true);
    const r = out.result as { ok: boolean; error: string; suggestions?: string[] };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[REDACTED:aws-access-key]");
    expect(r.suggestions?.[0]).toBe("[REDACTED:aws-access-key]");
  });

  it("adds no suggestions or recent_writes to a failure on an existing path", async () => {
    const registry = createBuiltinHookRegistry("/proj", {
      validate: {
        pathExists: () => true,
        listRepoFiles: () => ["src/other/index.ts", "src/more/index.ts"],
      },
    });
    const hookSession: HookSessionLike = {
      cwd: "/proj",
      isPlanMode: () => false,
      recentWritesForPath: () => [{ path: "/proj/src/ui/index.ts", turn: 1 }],
    };
    for (const error of ["Edit cancelled by user", "oldText not found in file"]) {
      const out = await registry.runPostToolCall({
        toolName: "edit_file",
        args: { path: "src/ui/index.ts" },
        result: { ok: false, error },
        isError: true,
        session: hookSession,
      });
      expect(out.isError).toBe(true);
      expect(out.result).toEqual({ ok: false, error });
    }
  });

  it("still adds suggestions when the path is missing", async () => {
    const registry = createBuiltinHookRegistry("/proj", {
      validate: { pathExists: () => false, listRepoFiles: () => ["/proj/src/other/index.ts"] },
    });
    const out = await registry.runPostToolCall({
      toolName: "edit_file",
      args: { path: "src/ui/index.ts" },
      result: { ok: false, error: "File not found: src/ui/index.ts" },
      isError: true,
      session: { cwd: "/proj", isPlanMode: () => false },
    });
    expect((out.result as { suggestions?: string[] }).suggestions).toContain("/proj/src/other/index.ts");
  });
});
