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
});
