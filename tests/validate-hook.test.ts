import { describe, expect, it } from "bun:test";
import { createValidateHandlers } from "../src/hooks/handlers/validate.js";
import type { HookSessionLike } from "../src/hooks/types.js";

function session(cwd: string, extra?: Partial<HookSessionLike>): HookSessionLike {
  return { cwd, isPlanMode: () => false, ...extra };
}

describe("validate pre_tool_call", () => {
  it("blocks missing read_file with suggestions", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => false,
      listRepoFiles: () => ["/proj/src/session.ts"],
    });
    const out = await pre({
      toolName: "read_file",
      args: { path: "sesion.ts" },
      session: session("/proj"),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.suggestions).toContain("/proj/src/session.ts");
      expect(out.isError).toBe(true);
    }
  });

  it("blocks unread existing edit_file", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => true,
      listRepoFiles: () => [],
    });
    const out = await pre({
      toolName: "edit_file",
      args: { path: "a.ts" },
      session: session("/proj", { hasReadPath: () => false }),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.error).toMatch(/read the file first/i);
    }
  });

  it("allows edit_file after a session read", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => true,
    });
    const out = await pre({
      toolName: "edit_file",
      args: { path: "a.ts" },
      session: session("/proj", { hasReadPath: () => true }),
    });
    expect(out).toBeUndefined();
  });

  it("skips unread check when hasReadPath is null", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => true,
    });
    const out = await pre({
      toolName: "edit_file",
      args: { path: "a.ts" },
      session: session("/proj", { hasReadPath: () => null }),
    });
    expect(out).toBeUndefined();
  });

  it("does not throw when listRepoFiles throws", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => false,
      listRepoFiles: () => {
        throw new Error("git failed");
      },
    });
    const out = await pre({
      toolName: "read_file",
      args: { path: "missing.ts" },
      session: session("/proj"),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.suggestions).toBeUndefined();
    }
  });

  it("blocks shell with an unknown first token", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      commandOnPath: () => false,
    });
    const out = await pre({
      toolName: "shell",
      args: { command: "no-such-bin-xyz" },
      session: session("/proj"),
    });
    expect(out?.action).toBe("block");
  });

  it("allows shell echo", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      commandOnPath: () => false,
    });
    const out = await pre({
      toolName: "shell",
      args: { command: "echo hi" },
      session: session("/proj"),
    });
    expect(out).toBeUndefined();
  });
});

describe("validate post_tool_call", () => {
  it("attaches suggestions and recent_writes on a failed write_file", async () => {
    const { post } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => false,
      listRepoFiles: () => ["/proj/src/a.ts"],
    });
    const patch = await post({
      toolName: "write_file",
      args: { path: "b.ts" },
      result: { ok: false, error: "sandbox" },
      isError: true,
      session: session("/proj", {
        recentWritesForPath: () => [{ path: "/proj/src/a.ts", turn: 2 }],
      }),
    });
    const result = patch?.result as {
      ok: boolean;
      suggestions?: string[];
      recent_writes?: Array<{ path: string }>;
    };
    expect(result.ok).toBe(false);
    expect(result.suggestions?.length).toBeGreaterThan(0);
    expect(result.recent_writes?.[0]?.path).toBe("/proj/src/a.ts");
  });

  it("does not enrich a successful result", async () => {
    const { post } = createValidateHandlers({ cwd: "/proj" });
    const patch = await post({
      toolName: "write_file",
      args: { path: "a.ts" },
      result: { ok: true },
      isError: false,
      session: session("/proj"),
    });
    expect(patch).toBeUndefined();
  });
});
