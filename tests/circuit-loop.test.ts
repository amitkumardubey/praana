import { describe, expect, it } from "bun:test";
import { isLoopExempt, LoopGate, CIRCUIT_LOOP_PREFIX, renderCircuitNotes } from "../src/circuit/loop-gate.js";

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

  it("does not count exempt calls", () => {
    const gate = new LoopGate({ threshold: 3 });
    for (let i = 0; i < 5; i++) {
      expect(gate.observePre("read_file", { path: "a.ts" })).toBeUndefined();
      expect(gate.observePre("shell", { command: "bun test" })).toBeUndefined();
    }
  });
});
