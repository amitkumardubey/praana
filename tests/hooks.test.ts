import { describe, it, expect } from "bun:test";
import {
  HookRegistry,
  registerBuiltinHooks,
  createBuiltinHookRegistry,
} from "../src/hooks/index.js";
import type { HookSessionLike } from "../src/hooks/types.js";

function fakeSession(overrides?: Partial<HookSessionLike>): HookSessionLike {
  return {
    cwd: "/tmp/praana-hooks-test",
    isPlanMode: () => false,
    ...overrides,
  };
}

describe("HookRegistry", () => {
  it("runs pre_tool_call handlers in registration order", async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    registry.onPreToolCall((ctx) => {
      order.push("a");
      return { args: { ...ctx.args, via: "a" } };
    });
    registry.onPreToolCall(async (ctx) => {
      order.push("b");
      return { args: { ...ctx.args, via: `${ctx.args.via}-b` } };
    });

    const result = await registry.runPreToolCall({
      toolName: "read_file",
      args: { path: "a.ts" },
      session: fakeSession(),
    });

    expect(order).toEqual(["a", "b"]);
    expect(result).toEqual({
      action: "continue",
      args: { path: "a.ts", via: "a-b" },
    });
  });

  it("short-circuits on block and skips later pre_tool_call handlers", async () => {
    const registry = new HookRegistry();
    let laterRan = false;
    registry.onPreToolCall(() => ({
      action: "block" as const,
      error: "nope",
      isError: true,
    }));
    registry.onPreToolCall(() => {
      laterRan = true;
    });

    const result = await registry.runPreToolCall({
      toolName: "write_file",
      args: { path: "a.ts", content: "x" },
      session: fakeSession(),
    });

    expect(laterRan).toBe(false);
    expect(result).toEqual({
      action: "block",
      error: "nope",
      isError: true,
    });
  });

  it("turns pre_tool_call handler throws into a structured denial", async () => {
    const registry = new HookRegistry();
    registry.onPreToolCall(() => {
      throw new Error("boom");
    });

    const result = await registry.runPreToolCall({
      toolName: "shell",
      args: { command: "echo hi" },
      session: fakeSession(),
    });

    expect(result).toEqual({
      action: "block",
      error: "boom",
      isError: true,
    });
  });

  it("runs post_tool_call handlers in order and applies result patches", async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    registry.onPostToolCall((ctx) => {
      order.push("a");
      return { result: { ...(ctx.result as object), a: true } };
    });
    registry.onPostToolCall(async (ctx) => {
      order.push("b");
      return { result: { ...(ctx.result as object), b: true }, isError: false };
    });

    const result = await registry.runPostToolCall({
      toolName: "read_file",
      args: { path: "a.ts" },
      result: { ok: true },
      isError: false,
      session: fakeSession(),
    });

    expect(order).toEqual(["a", "b"]);
    expect(result).toEqual({
      result: { ok: true, a: true, b: true },
      isError: false,
    });
  });

  it("logs and continues when a post_tool_call handler throws", async () => {
    const warnings: string[] = [];
    const registry = new HookRegistry();
    registry.onPostToolCall(() => {
      throw new Error("post failed");
    });
    registry.onPostToolCall((ctx) => ({
      result: { ...(ctx.result as object), recovered: true },
    }));

    const result = await registry.runPostToolCall({
      toolName: "read_file",
      args: { path: "a.ts" },
      result: { ok: true },
      isError: false,
      session: fakeSession({
        getLogger: () => ({
          child: () => ({
            warn: (message: string) => {
              warnings.push(message);
            },
          }),
        }),
      }),
    });

    expect(warnings.some((m) => m.includes("post_tool_call"))).toBe(true);
    expect(result).toEqual({
      result: { ok: true, recovered: true },
      isError: false,
    });
  });

  it("runs pre_compile handlers in order and allows input mutation", async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    registry.onPreCompile((ctx) => {
      order.push("a");
      ctx.input.userInput = `${String(ctx.input.userInput)} A`;
    });
    registry.onPreCompile(async (ctx) => {
      order.push("b");
      ctx.input.userInput = `${String(ctx.input.userInput)} B`;
    });

    const input: Record<string, unknown> = { userInput: "hi" };
    await registry.runPreCompile({ session: fakeSession(), input });

    expect(order).toEqual(["a", "b"]);
    expect(input.userInput).toBe("hi A B");
  });

  it("runs post_turn, session_start, and session_end handlers in order", async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    registry.onPostTurn(() => {
      order.push("post_turn");
    });
    registry.onSessionStart(async () => {
      order.push("session_start");
    });
    registry.onSessionEnd(() => {
      order.push("session_end");
    });

    const session = fakeSession();
    await registry.runSessionStart({ session, reason: "create" });
    await registry.runPostTurn({ session, turn: 1 });
    await registry.runSessionEnd({ session, reason: "clean" });

    expect(order).toEqual(["session_start", "post_turn", "session_end"]);
  });

  it("swallows lifecycle handler throws after logging", async () => {
    const warnings: string[] = [];
    const registry = new HookRegistry();
    registry.onSessionStart(() => {
      throw new Error("start failed");
    });
    registry.onSessionEnd(() => {
      throw new Error("end failed");
    });
    registry.onPreCompile(() => {
      throw new Error("compile failed");
    });
    registry.onPostTurn(() => {
      throw new Error("turn failed");
    });

    const session = fakeSession({
      getLogger: () => ({
        child: () => ({
          warn: (message: string) => {
            warnings.push(message);
          },
        }),
      }),
    });

    await registry.runSessionStart({ session, reason: "create" });
    await registry.runPreCompile({ session, input: {} });
    await registry.runPostTurn({ session, turn: 1 });
    await registry.runSessionEnd({ session, reason: "clean" });

    expect(warnings).toHaveLength(4);
  });
});

describe("builtin hook handlers", () => {
  it("blocks mutating tools in plan mode with isError true", async () => {
    const registry = createBuiltinHookRegistry("/tmp/praana-hooks-test");
    const result = await registry.runPreToolCall({
      toolName: "write_file",
      args: { path: "a.ts", content: "x" },
      session: fakeSession({ isPlanMode: () => true }),
    });

    expect(result.action).toBe("block");
    if (result.action === "block") {
      expect(result.isError).toBe(true);
      expect(result.error).toContain("Plan mode is active");
    }
  });

  it("allows read-only tools in plan mode", async () => {
    const registry = createBuiltinHookRegistry("/tmp/praana-hooks-test");
    const result = await registry.runPreToolCall({
      toolName: "read_file",
      args: { path: "a.ts" },
      session: fakeSession({ isPlanMode: () => true }),
    });
    expect(result).toEqual({
      action: "continue",
      args: { path: "a.ts" },
    });
  });

  it("blocks a second concurrent write without marking isError", async () => {
    const registry = new HookRegistry();
    registerBuiltinHooks(registry, "/tmp/praana-hooks-test");
    const session = fakeSession();

    const first = await registry.runPreToolCall({
      toolName: "write_file",
      args: { path: "a.ts", content: "one" },
      session,
    });
    expect(first.action).toBe("continue");

    const second = await registry.runPreToolCall({
      toolName: "edit_file",
      args: { path: "a.ts", oldText: "one", newText: "two" },
      session,
    });
    expect(second.action).toBe("block");
    if (second.action === "block") {
      expect(second.isError).toBe(false);
      expect(second.error).toContain("Concurrent write already in progress");
    }
  });

  it("blocks read_file while a write lock is held", async () => {
    const registry = createBuiltinHookRegistry("/tmp/praana-hooks-test");
    const session = fakeSession();

    await registry.runPreToolCall({
      toolName: "write_file",
      args: { path: "race.txt", content: "x" },
      session,
    });

    const read = await registry.runPreToolCall({
      toolName: "read_file",
      args: { path: "race.txt" },
      session,
    });
    expect(read.action).toBe("block");
    if (read.action === "block") {
      expect(read.isError).toBe(false);
      expect(read.error).toContain("in progress");
    }
  });

  it("releases write locks on post_tool_call", async () => {
    const registry = createBuiltinHookRegistry("/tmp/praana-hooks-test");
    const session = fakeSession();
    const args = { path: "a.ts", content: "x" };

    await registry.runPreToolCall({ toolName: "write_file", args, session });
    await registry.runPostToolCall({
      toolName: "write_file",
      args,
      result: { ok: true },
      isError: false,
      session,
    });

    const again = await registry.runPreToolCall({
      toolName: "write_file",
      args,
      session,
    });
    expect(again.action).toBe("continue");
  });

  it("does not hold a write lock after a plan-mode block", async () => {
    const registry = createBuiltinHookRegistry("/tmp/praana-hooks-test");
    const session = fakeSession({ isPlanMode: () => true });

    const blocked = await registry.runPreToolCall({
      toolName: "write_file",
      args: { path: "a.ts", content: "x" },
      session,
    });
    expect(blocked.action).toBe("block");

    const after = await registry.runPreToolCall({
      toolName: "write_file",
      args: { path: "a.ts", content: "x" },
      session: fakeSession({ isPlanMode: () => false }),
    });
    expect(after.action).toBe("continue");
  });

  it("acquires all batch_write paths and releases them together", async () => {
    const registry = createBuiltinHookRegistry("/tmp/praana-hooks-test");
    const session = fakeSession();
    const args = {
      files: [
        { path: "a.ts", content: "a" },
        { path: "b.ts", content: "b" },
        { path: "a.ts", content: "a2" },
      ],
    };

    const pre = await registry.runPreToolCall({
      toolName: "batch_write",
      args,
      session,
    });
    expect(pre.action).toBe("continue");

    const conflictA = await registry.runPreToolCall({
      toolName: "write_file",
      args: { path: "a.ts", content: "x" },
      session,
    });
    const conflictB = await registry.runPreToolCall({
      toolName: "write_file",
      args: { path: "b.ts", content: "x" },
      session,
    });
    expect(conflictA.action).toBe("block");
    expect(conflictB.action).toBe("block");

    await registry.runPostToolCall({
      toolName: "batch_write",
      args,
      result: { ok: true },
      isError: false,
      session,
    });

    const after = await registry.runPreToolCall({
      toolName: "write_file",
      args: { path: "a.ts", content: "x" },
      session,
    });
    expect(after.action).toBe("continue");
  });
});
