import { describe, expect, it, spyOn } from "bun:test";
import { getAppLogger } from "../src/logger.js";
import { createBuiltinHookRegistry } from "../src/hooks/index.js";
import { HookRegistry } from "../src/hooks/registry.js";
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

  it("logs only the redacted JSON projection of Buffer and Map tool results", async () => {
    const post = createRedactPostToolCallHandler();
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const bytes = Buffer.from(secret);
    const map = Object.assign(new Map([[secret, secret]]), { token: secret });
    const result = { ok: true, bytes, map };
    const patch = await post({ toolName: "shell", args: {}, result, isError: false, session: session() });
    const logged = JSON.stringify({ kind: "tool_result", payload: { result: patch?.result } });
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(JSON.stringify([...bytes]));
    const projected = JSON.parse(JSON.stringify({
      ok: true, bytes: `[binary: ${bytes.length} bytes]`, map,
    }));
    const projectedPatch = await post({ toolName: "shell", args: {}, result: projected, isError: false, session: session() });
    expect(patch?.result).toEqual(projectedPatch?.result);
    expect(patch?.result).toEqual({
      ok: true, bytes: `[binary: ${bytes.length} bytes]`, map: { token: "[REDACTED:aws-access-key]" },
    });
    expect(patch?.isError).toBeUndefined();
  });

  it("redacts a 5 MB string in full instead of replacing it", async () => {
    const post = createRedactPostToolCallHandler();
    const filler = "q".repeat(5 * 1024 * 1024);
    const patch = await post({
      toolName: "shell",
      args: {},
      result: { ok: true, stdout: `${filler} AKIAIOSFODNN7EXAMPLE tail`, stderr: "warn" },
      isError: false,
      session: session(),
    });
    expect(patch?.result).toEqual({
      ok: true, stdout: `${filler} [REDACTED:aws-access-key] tail`, stderr: "warn",
    });
  });

  it("keeps a redacted Error message in a failed result", async () => {
    const post = createRedactPostToolCallHandler();
    const patch = await post({
      toolName: "shell",
      args: {},
      result: { ok: false, error: new Error("boom AKIAIOSFODNN7EXAMPLE") },
      isError: true,
      session: session(),
    });
    expect(patch?.result).toEqual({
      ok: false, error: { name: "Error", message: "boom [REDACTED:aws-access-key]" },
    });
  });

  it("never lets the original through when the JSON projection is omitted", async () => {
    const secretive = { secret: "AKIAIOSFODNN7EXAMPLE", toJSON() { return undefined; } };
    const patch = await createRedactPostToolCallHandler()({
      toolName: "shell", args: {}, result: secretive, isError: false, session: session(),
    });
    expect(patch?.result).toBeNull();
    const registry = createBuiltinHookRegistry("/proj", { validate: { pathExists: () => true, listRepoFiles: () => [] } });
    const out = await registry.runPostToolCall({
      toolName: "shell", args: {}, result: secretive, isError: false, session: session(),
    });
    expect(out.result).toBeNull();
    expect(JSON.stringify(out)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("replaces the result with the placeholder when redaction itself throws, never the original", async () => {
    const throwing = () => { throw new Error("redactor broke"); };
    const original = { ok: true, stdout: "AKIAIOSFODNN7EXAMPLE" };
    const registry = new HookRegistry();
    registry.onPostToolCall(createRedactPostToolCallHandler(throwing));
    const out = await registry.runPostToolCall({
      toolName: "shell", args: {}, result: original, isError: false, session: session(),
    });
    expect(out.result).toEqual({ error: "[REDACTED:redaction-error]" });
    expect(JSON.stringify(out)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const text = await registry.runPostToolCall({
      toolName: "shell", args: {}, result: "AKIAIOSFODNN7EXAMPLE", isError: false, session: session(),
    });
    expect(text.result).toBe("[REDACTED:redaction-error]");
    // A context whose result cannot even be read is replaced too.
    const hostile = { toolName: "shell", args: {}, isError: false, session: session(), get result(): unknown { throw new Error("no"); } };
    expect(await createRedactPostToolCallHandler()(hostile)).toEqual({ result: { error: "[REDACTED:redaction-error]" } });
  });

  it("returns the placeholder even when logging the redaction failure throws", async () => {
    const logger = spyOn(getAppLogger(), "child").mockImplementation(() => { throw new Error("logger failed"); });
    try {
      const post = createRedactPostToolCallHandler(() => { throw new Error("redactor failed"); });
      expect(await post({ toolName: "shell", args: {}, result: "secret", isError: false, session: session() }))
        .toEqual({ result: "[REDACTED:redaction-error]" });
    } finally {
      logger.mockRestore();
    }
  });

  it("applies a patch that has a result key, even null, and keeps the original for a patch without one", async () => {
    const original = { ok: true };
    const run = async (patch: { result?: unknown; isError?: boolean } | void) => {
      const registry = new HookRegistry();
      registry.onPostToolCall(() => patch);
      return (await registry.runPostToolCall({
        toolName: "shell", args: {}, result: original, isError: false, session: session(),
      })).result;
    };
    expect(await run({})).toBe(original);
    expect(await run({ isError: true })).toBe(original);
    expect(await run()).toBe(original);
    expect(await run({ result: null })).toBeNull();
    expect(await run({ result: { x: 1 } })).toEqual({ x: 1 });
  });

  it("keeps every field of a 120000-match result", async () => {
    const matches = Array.from({ length: 120_000 }, (_, i) => `m${i}`);
    const patch = await createRedactPostToolCallHandler()({
      toolName: "search_code", args: {}, result: { matches, ok: true, total: 120_000 }, isError: false, session: session(),
    });
    const result = patch?.result as { matches: string[]; ok: boolean; total: number };
    expect(result.matches).toHaveLength(120_000);
    expect([result.ok, result.total]).toEqual([true, 120_000]);
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
