import { describe, expect, it } from "bun:test";
import { replaySession } from "../../src/benchmark/session-replay.js";
import type { Event } from "../../src/types.js";

describe("replaySession", () => {
  it("should replay events into turn snapshots", () => {
    const events: Event[] = [
      { kind: "user_message", payload: { text: "fix the bug" }, timestamp: 1 },
      { kind: "agent_message", payload: { text: "I'll look into it" }, timestamp: 2 },
      { kind: "tool_call", payload: { tool: "read_file", args: { path: "src/foo.ts" } }, timestamp: 3 },
      { kind: "tool_result", payload: { tool: "read_file", result: "file contents" }, timestamp: 4 },
      { kind: "user_message", payload: { text: "now test it" }, timestamp: 5 },
    ];

    const turns = replaySession(events);
    expect(turns.length).toBe(2); // Two user messages = two turns
    expect(turns[0].userMessage).toBe("fix the bug");
    expect(turns[1].userMessage).toBe("now test it");
  });

  it("should track tool calls per turn", () => {
    const events: Event[] = [
      { kind: "user_message", payload: { text: "read foo" }, timestamp: 1 },
      { kind: "tool_call", payload: { tool: "read_file", args: { path: "foo.ts" } }, timestamp: 2 },
      { kind: "tool_result", payload: { tool: "read_file", result: "contents" }, timestamp: 3 },
      { kind: "agent_message", payload: { text: "done" }, timestamp: 4 },
    ];

    const turns = replaySession(events);
    expect(turns[0].toolCalls.length).toBe(1);
    expect(turns[0].toolCalls[0].tool).toBe("read_file");
  });

  it("should track files read and written", () => {
    const events: Event[] = [
      { kind: "user_message", payload: { text: "edit foo" }, timestamp: 1 },
      { kind: "tool_call", payload: { tool: "read_file", args: { path: "foo.ts" } }, timestamp: 2 },
      { kind: "tool_result", payload: { tool: "read_file", result: "contents" }, timestamp: 3 },
      { kind: "tool_call", payload: { tool: "write_file", args: { path: "bar.ts" } }, timestamp: 4 },
      { kind: "tool_result", payload: { tool: "write_file", result: "written" }, timestamp: 5 },
    ];

    const turns = replaySession(events);
    expect(turns[0].filesRead).toEqual(["foo.ts"]);
    expect(turns[0].filesWritten).toEqual(["bar.ts"]);
  });
});
