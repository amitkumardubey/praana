import { describe, expect, it } from "bun:test";
import { isLoopExempt, LoopGate, CIRCUIT_LOOP_PREFIX, renderCircuitNotes } from "../src/circuit/loop-gate.js";

type ReplayEvent = { kind: string; payload: Record<string, unknown> };

describe("isLoopExempt", () => {
  it("exempts reads and tests", () => {
    expect(isLoopExempt("read_file", { path: "a.ts" })).toBe(true);
    expect(isLoopExempt("git_status", {})).toBe(true);
    expect(isLoopExempt("shell", { command: "git status" })).toBe(true);
    expect(isLoopExempt("shell", { command: "bun test" })).toBe(true);
    expect(isLoopExempt("shell", { command: "npm test" })).toBe(true);
  });

  it("does not exempt mutating shell", () => {
    expect(isLoopExempt("edit_file", { path: "a.ts", oldText: "x", newText: "y" })).toBe(false);
    expect(isLoopExempt("shell", { command: "rm -rf /tmp/x" })).toBe(false);
  });
});

describe("LoopGate", () => {
  it("blocks the third identical mutating args and notes once", () => {
    const texts: string[] = [];
    const gate = new LoopGate({
      threshold: 3,
      onFirstBlock: (t) => texts.push(t),
    });
    const args = { command: "rm -rf /tmp/x" };
    expect(gate.observePre("shell", args)).toBeUndefined();
    expect(gate.observePre("shell", args)).toBeUndefined();
    const third = gate.observePre("shell", args);
    expect(third?.action).toBe("block");
    expect(third?.error).toContain(CIRCUIT_LOOP_PREFIX);
    expect(texts).toHaveLength(1);
    expect(gate.notes()).toHaveLength(1);
    expect(gate.observePre("shell", args)?.action).toBe("block");
    expect(texts).toHaveLength(1);
  });

  it("blocks the third attempt after two errors on the same path", () => {
    const gate = new LoopGate({ threshold: 3 });
    gate.observePre("edit_file", { path: "a.ts", oldText: "a", newText: "b" });
    gate.observePost("edit_file", { path: "a.ts", oldText: "a", newText: "b" }, true);
    gate.observePre("edit_file", { path: "a.ts", oldText: "c", newText: "d" });
    gate.observePost("edit_file", { path: "a.ts", oldText: "c", newText: "d" }, true);
    const third = gate.observePre("edit_file", { path: "a.ts", oldText: "e", newText: "f" });
    expect(third?.action).toBe("block");
  });

  it("does not block three successful edits of the same path with different args", () => {
    const gate = new LoopGate({ threshold: 3 });
    expect(gate.observePre("edit_file", { path: "a.ts", oldText: "a", newText: "b" })).toBeUndefined();
    expect(gate.observePre("edit_file", { path: "a.ts", oldText: "b", newText: "c" })).toBeUndefined();
    expect(gate.observePre("edit_file", { path: "a.ts", oldText: "c", newText: "d" })).toBeUndefined();
  });

  it("renders a circuit section", () => {
    expect(renderCircuitNotes(["Circuit breaker: shell …"])).toContain("## Circuit Breakers");
  });

  it("replays tool_call / tool_result events", () => {
    const events = [
      { kind: "tool_call", payload: { tool: "shell", args: { command: "rm -rf /tmp/x" } } },
      { kind: "tool_result", payload: { tool: "shell", result: { ok: true } } },
      { kind: "tool_call", payload: { tool: "shell", args: { command: "rm -rf /tmp/x" } } },
      { kind: "tool_result", payload: { tool: "shell", result: { ok: true } } },
      { kind: "system_note", payload: { type: "circuit_note", text: "Circuit breaker: shell …" } },
    ];
    const gate = LoopGate.fromEvents(events as any, { threshold: 3 });
    expect(gate.observePre("shell", { command: "rm -rf /tmp/x" })?.action).toBe("block");
    expect(gate.notes()[0]).toContain("Circuit breaker:");
  });

  it("does not count exempt calls", () => {
    const gate = new LoopGate({ threshold: 3 });
    for (let i = 0; i < 5; i++) {
      expect(gate.observePre("read_file", { path: "a.ts" })).toBeUndefined();
      expect(gate.observePre("shell", { command: "bun test" })).toBeUndefined();
    }
  });

  it("does not block on errors separated by a success", () => {
    const gate = new LoopGate({ threshold: 3 });
    const path = "src/turn.ts";
    const first = { path, oldText: "a", newText: "b" };
    const second = { path, oldText: "b", newText: "c" };
    const third = { path, oldText: "c", newText: "d" };
    const fourth = { path, oldText: "d", newText: "e" };
    expect(gate.observePre("edit_file", first)).toBeUndefined();
    gate.observePost("edit_file", first, true);
    expect(gate.observePre("edit_file", second)).toBeUndefined();
    gate.observePost("edit_file", second, false);
    expect(gate.observePre("edit_file", third)).toBeUndefined();
    gate.observePost("edit_file", third, true);
    expect(gate.observePre("edit_file", fourth)).toBeUndefined();
    expect(gate.notes()).toHaveLength(0);
  });

  it("still blocks the third attempt after two consecutive errors", () => {
    const gate = new LoopGate({ threshold: 3 });
    const path = "src/turn.ts";
    const first = { path, oldText: "a", newText: "b" };
    const second = { path, oldText: "b", newText: "c" };
    const third = { path, oldText: "c", newText: "d" };
    gate.observePre("edit_file", first);
    gate.observePost("edit_file", first, true);
    gate.observePre("edit_file", second);
    gate.observePost("edit_file", second, true);
    expect(gate.observePre("edit_file", third)?.action).toBe("block");
  });

  it("replays a success between two failures without blocking", () => {
    const path = "src/turn.ts";
    const events = [
      {
        kind: "tool_call",
        payload: { tool: "edit_file", args: { path, oldText: "a", newText: "b" } },
      },
      { kind: "tool_result", payload: { tool: "edit_file", result: { ok: false } } },
      {
        kind: "tool_call",
        payload: { tool: "edit_file", args: { path, oldText: "b", newText: "c" } },
      },
      { kind: "tool_result", payload: { tool: "edit_file", result: { ok: true } } },
      {
        kind: "tool_call",
        payload: { tool: "edit_file", args: { path, oldText: "c", newText: "d" } },
      },
      { kind: "tool_result", payload: { tool: "edit_file", result: { ok: false } } },
    ];
    const gate = LoopGate.fromEvents(events as any, { threshold: 3 });
    expect(gate.observePre("edit_file", { path, oldText: "d", newText: "e" })).toBeUndefined();
    expect(gate.notes()).toHaveLength(0);
  });

  it("replays two consecutive failures as a block", () => {
    const path = "src/turn.ts";
    const events = [
      {
        kind: "tool_call",
        payload: { tool: "edit_file", args: { path, oldText: "a", newText: "b" } },
      },
      { kind: "tool_result", payload: { tool: "edit_file", result: { ok: false } } },
      {
        kind: "tool_call",
        payload: { tool: "edit_file", args: { path, oldText: "b", newText: "c" } },
      },
      { kind: "tool_result", payload: { tool: "edit_file", result: { ok: false } } },
    ];
    const gate = LoopGate.fromEvents(events as any, { threshold: 3 });
    expect(gate.observePre("edit_file", { path, oldText: "c", newText: "d" })?.action).toBe(
      "block",
    );
  });

  it("pairs parallel batch results with their own call by toolCallId", () => {
    const pathA = "src/a.ts";
    const pathB = "src/b.ts";
    const batch = (oldTextA: string, oldTextB: string, n: number): ReplayEvent[] => [
      {
        kind: "tool_call",
        payload: {
          toolCallId: `call-a${n}`,
          tool: "edit_file",
          args: { path: pathA, oldText: oldTextA, newText: "x" },
        },
      },
      {
        kind: "tool_call",
        payload: {
          toolCallId: `call-b${n}`,
          tool: "edit_file",
          args: { path: pathB, oldText: oldTextB, newText: "x" },
        },
      },
      {
        kind: "tool_result",
        payload: { toolCallId: `call-a${n}`, tool: "edit_file", result: { ok: false } },
      },
      {
        kind: "tool_result",
        payload: { toolCallId: `call-b${n}`, tool: "edit_file", result: { ok: true } },
      },
    ];
    const events = [...batch("a1", "b1", 1), ...batch("a2", "b2", 2)];
    const gate = LoopGate.fromEvents(events, { threshold: 3 });
    expect(
      gate.observePre("edit_file", { path: pathA, oldText: "a3", newText: "x" })?.action,
    ).toBe("block");
    expect(
      gate.observePre("edit_file", { path: pathB, oldText: "b3", newText: "x" }),
    ).toBeUndefined();
  });

  it("falls back to the preceding call when a result has no toolCallId", () => {
    const path = "src/circuit/loop-gate.ts";
    const events: ReplayEvent[] = [
      {
        kind: "tool_call",
        payload: {
          toolCallId: "call-1",
          tool: "edit_file",
          args: { path, oldText: "a", newText: "b" },
        },
      },
      { kind: "tool_result", payload: { tool: "edit_file", result: { ok: false } } },
      {
        kind: "tool_call",
        payload: {
          toolCallId: "call-2",
          tool: "edit_file",
          args: { path, oldText: "b", newText: "c" },
        },
      },
      { kind: "tool_result", payload: { tool: "edit_file", result: { ok: false } } },
    ];
    const gate = LoopGate.fromEvents(events, { threshold: 3 });
    expect(gate.observePre("edit_file", { path, oldText: "c", newText: "d" })?.action).toBe(
      "block",
    );
  });

  it("resets the error streak on a success with different args on the same path", () => {
    const path = "src/circuit/loop-gate.ts";
    const events: ReplayEvent[] = [
      {
        kind: "tool_call",
        payload: {
          toolCallId: "call-1",
          tool: "edit_file",
          args: { path, oldText: "a", newText: "b" },
        },
      },
      {
        kind: "tool_result",
        payload: { toolCallId: "call-1", tool: "edit_file", result: { ok: false } },
      },
      {
        kind: "tool_call",
        payload: {
          toolCallId: "call-2",
          tool: "edit_file",
          args: { path, oldText: "zzz", newText: "b" },
        },
      },
      {
        kind: "tool_result",
        payload: { toolCallId: "call-2", tool: "edit_file", result: { ok: true } },
      },
      {
        kind: "tool_call",
        payload: {
          toolCallId: "call-3",
          tool: "edit_file",
          args: { path, oldText: "b", newText: "c" },
        },
      },
      {
        kind: "tool_result",
        payload: { toolCallId: "call-3", tool: "edit_file", result: { ok: false } },
      },
    ];
    const gate = LoopGate.fromEvents(events, { threshold: 3 });
    expect(gate.observePre("edit_file", { path, oldText: "c", newText: "d" })).toBeUndefined();
    expect(gate.notes()).toHaveLength(0);
  });

  it("never counts or resets on exempt calls", () => {
    const gate = new LoopGate({ threshold: 3 });
    const path = "src/turn.ts";
    for (let i = 0; i < 5; i++) {
      gate.observePost("read_file", { path }, true);
      gate.observePost("shell", { command: "bun test" }, true);
      gate.observePost("shell", { command: "git status" }, true);
      expect(gate.observePre("read_file", { path })).toBeUndefined();
      expect(gate.observePre("shell", { command: "bun test" })).toBeUndefined();
      expect(gate.observePre("shell", { command: "git status" })).toBeUndefined();
    }
    expect(gate.notes()).toHaveLength(0);
    const first = { path, oldText: "a", newText: "b" };
    const second = { path, oldText: "b", newText: "c" };
    const third = { path, oldText: "c", newText: "d" };
    gate.observePre("edit_file", first);
    gate.observePost("edit_file", first, true);
    gate.observePost("read_file", { path }, false);
    gate.observePre("edit_file", second);
    gate.observePost("edit_file", second, true);
    gate.observePost("read_file", { path }, false);
    expect(gate.observePre("edit_file", third)?.action).toBe("block");
  });
});
