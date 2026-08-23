import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LoopGate } from "../src/circuit/loop-gate.js";
import { createBuiltinHookRegistry } from "../src/hooks/index.js";
import type { HookSessionLike } from "../src/hooks/types.js";

function sessionWithGate(cwd: string): HookSessionLike {
  const gate = new LoopGate({ threshold: 3 });
  return {
    cwd,
    isPlanMode: () => false,
    observeCircuitPre: (tool, args) => gate.observePre(tool, args),
    observeCircuitPost: (tool, args, isError) => gate.observePost(tool, args, isError),
    circuitNotes: () => gate.notes(),
    confirmRisk: async () => ({ allowed: true }),
  };
}

describe("circuit pre_tool_call", () => {
  it("blocks the third identical mutating shell command", async () => {
    const registry = createBuiltinHookRegistry("/proj", {
      validate: { pathExists: () => true, commandOnPath: () => true },
    });
    const sess = sessionWithGate("/proj");
    const args = { command: "rm -rf /tmp/praana-circuit-hook" };

    const first = await registry.runPreToolCall({
      toolName: "shell",
      args,
      session: sess,
    });
    expect(first.action).toBe("continue");
    await registry.runPostToolCall({
      toolName: "shell",
      args,
      result: { ok: true },
      isError: false,
      session: sess,
    });

    const second = await registry.runPreToolCall({
      toolName: "shell",
      args,
      session: sess,
    });
    expect(second.action).toBe("continue");
    await registry.runPostToolCall({
      toolName: "shell",
      args,
      result: { ok: true },
      isError: false,
      session: sess,
    });

    const third = await registry.runPreToolCall({
      toolName: "shell",
      args,
      session: sess,
    });
    expect(third.action).toBe("block");
    if (third.action === "block") {
      expect(third.error).toContain("Circuit breaker:");
    }
  });

  it("lets validate block a missing read before circuit", async () => {
    const registry = createBuiltinHookRegistry("/proj", {
      validate: { pathExists: () => false, listRepoFiles: () => [] },
    });
    const sess = sessionWithGate("/proj");
    const blocked = await registry.runPreToolCall({
      toolName: "read_file",
      args: { path: "missing.ts" },
      session: sess,
    });
    expect(blocked.action).toBe("block");
    if (blocked.action === "block") {
      expect(blocked.error).not.toContain("Circuit breaker:");
    }
  });

  it("does not hold a write lock after a circuit block", async () => {
    const dir = join(tmpdir(), `praana-circuit-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "x\n");
    try {
      const registry = createBuiltinHookRegistry(dir, {
        validate: { pathExists: () => true, commandOnPath: () => true },
      });
      const sess = sessionWithGate(dir);
      const writeArgs = { path: "a.ts", content: "y" };

      for (let i = 0; i < 2; i++) {
        const pre = await registry.runPreToolCall({
          toolName: "write_file",
          args: writeArgs,
          session: sess,
        });
        expect(pre.action).toBe("continue");
        await registry.runPostToolCall({
          toolName: "write_file",
          args: writeArgs,
          result: { ok: true },
          isError: false,
          session: sess,
        });
      }

      const blocked = await registry.runPreToolCall({
        toolName: "write_file",
        args: writeArgs,
        session: sess,
      });
      expect(blocked.action).toBe("block");

      const read = await registry.runPreToolCall({
        toolName: "read_file",
        args: { path: "a.ts" },
        session: sess,
      });
      expect(read.action).toBe("continue");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
