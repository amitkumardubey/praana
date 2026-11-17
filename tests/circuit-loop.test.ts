import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { isLoopExempt, LoopGate, CIRCUIT_LOOP_PREFIX, renderCircuitNotes } from "../src/circuit/loop-gate.js";

describe("isLoopExempt", () => {
  it("keeps reads, tests and read-only git exempt", () => {
    for (const [tool, args] of [["read_file", { path: "a.ts" }], ["git_status", {}], ["shell", { command: "git status" }], ["shell", { command: "bun test" }], ["shell", { command: "cat a.ts" }]] as const) {
      expect(isLoopExempt(tool, args)).toBe(true);
    }
    expect(isLoopExempt("edit_file", { path: "a.ts" })).toBe(false);
    expect(isLoopExempt("shell", { command: "rm -rf /tmp/x" })).toBe(false);
  });
});

describe("LoopGate", () => {
  it("allows different edits after two failures and advises from the second until success", () => {
    const gate = new LoopGate();
    const edit = (n: number) => ({ path: "a.ts", oldText: String(n), newText: "x" });
    expect(gate.observePre("edit_file", edit(1))).toBeUndefined();
    expect(gate.observePost("edit_file", edit(1), true)).toBeUndefined();
    expect(gate.observePre("edit_file", edit(2))).toBeUndefined();
    expect(gate.observePost("edit_file", edit(2), true)).toBeDefined();
    expect(gate.observePre("edit_file", edit(3))).toBeUndefined();
    expect(gate.observePost("edit_file", edit(3), true)).toBeDefined();
    gate.observePost("edit_file", edit(4), false);
    expect(gate.observePost("edit_file", edit(5), true)).toBeUndefined();
  });

  it("resets error streaks with the turn so an old failure does not advise a later first failure", () => {
    const gate = new LoopGate();
    const edit = (n: number) => ({ path: "a.ts", oldText: String(n), newText: "x" });
    expect(gate.observePost("edit_file", edit(1), true)).toBeUndefined();
    gate.resetTurn();
    expect(gate.observePost("edit_file", edit(2), true)).toBeUndefined();
    expect(gate.observePost("edit_file", edit(3), true)).toBe(true);
  });

  it("clears all tool streaks for a successfully read path, normalizing against cwd", () => {
    const gate = new LoopGate();
    const cwd = "/project";
    const rel = { path: "src/a.ts" };
    const abs = { path: resolve(cwd, rel.path) };
    for (const tool of ["edit_file", "write_file"]) {
      gate.observePost(tool, rel, true, cwd);
      expect(gate.observePost(tool, abs, true, cwd)).toBeDefined();
    }
    gate.observePost("read_file", abs, false, cwd);
    for (const tool of ["edit_file", "write_file"]) {
      expect(gate.observePost(tool, rel, true, cwd)).toBeUndefined();
      expect(gate.observePost(tool, abs, true, cwd)).toBeDefined();
    }
    gate.observePost("read_file", rel, false, cwd);
    for (const tool of ["edit_file", "write_file"]) expect(gate.observePost(tool, abs, true, cwd)).toBeUndefined();
  });

  it("does not clear another path or clear a streak on a failed read", () => {
    const gate = new LoopGate();
    const a = { path: "a.ts" };
    const b = { path: "b.ts" };
    gate.observePost("edit_file", a, true, "/project");
    gate.observePost("read_file", b, false, "/project");
    gate.observePost("read_file", a, true, "/project");
    expect(gate.observePost("edit_file", a, true, "/project")).toBe(true);
    expect(gate.observePost("edit_file", b, true, "/project")).toBeUndefined();
  });

  it("blocks the third identical call only within a turn", () => {
    const notes: string[] = [];
    const gate = new LoopGate({ onFirstBlock: (text) => notes.push(text) });
    const args = { command: "rm -rf /tmp/x" };
    expect(gate.observePre("shell", args)).toBeUndefined();
    expect(gate.observePre("shell", args)).toBeUndefined();
    expect(gate.observePre("shell", args)?.error).toContain(CIRCUIT_LOOP_PREFIX);
    gate.resetTurn();
    expect(gate.observePre("shell", args)).toBeUndefined();
    expect(notes).toHaveLength(1);
    expect(renderCircuitNotes(gate.notes())).toContain("## Circuit Breakers");
  });

  it("resumes with empty counts but adopts circuit notes", () => {
    const args = { path: "a.ts", oldText: "a", newText: "b" };
    const events = [
      ...[1, 2, 3].flatMap((id) => [
        { kind: "tool_call", payload: { toolCallId: String(id), tool: "edit_file", args } },
        { kind: "tool_result", payload: { toolCallId: String(id), result: { ok: false } } },
      ]),
      { kind: "system_note", payload: { type: "circuit_note", text: "Circuit breaker: earlier" } },
    ];
    const gate = LoopGate.fromEvents(events);
    expect(gate.notes()).toEqual(["Circuit breaker: earlier"]);
    expect(gate.observePre("edit_file", args)).toBeUndefined();
    expect(gate.observePost("edit_file", args, true)).toBeUndefined();
    expect(gate.observePre("edit_file", { ...args, oldText: "different" })).toBeUndefined();
  });

  it("matches a seeded reference model over interleaved turns, edits and reads", () => {
    const gate = new LoopGate();
    const counts = new Map<string, number>();
    const errors = new Map<string, number>();
    let seed = 0x91827364;
    const rand = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
    for (let i = 0; i < 2000; i++) {
      const op = rand(5);
      const path = `src/${rand(3)}.ts`;
      if (op === 0) { counts.clear(); errors.clear(); gate.resetTurn(); continue; }
      if (op === 3) { errors.delete(path); gate.observePost("read_file", { path }, false, "/project"); continue; }
      const args = { path, oldText: op === 4 ? "repeat" : String(i), newText: "x" };
      const key = JSON.stringify(args);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      const blocked = gate.observePre("edit_file", args)?.action === "block";
      expect(blocked).toBe(count >= 3);
      if (blocked) continue;
      const failed = op === 2 || op === 4;
      const streak = failed ? (errors.get(path) ?? 0) + 1 : 0;
      errors.set(path, streak);
      expect(gate.observePost("edit_file", args, failed, "/project") !== undefined).toBe(failed && streak >= 2);
    }
  });
});
