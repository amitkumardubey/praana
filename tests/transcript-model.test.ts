import { describe, it, expect } from "bun:test";
import type { Event } from "../src/types.js";
import { buildTranscriptFromEvents } from "../src/ui/tui/transcript/model.js";

function ev(kind: Event["kind"], payload: Record<string, unknown>): Event {
  return {
    event_id: "ev_test",
    session_id: "sess",
    timestamp: Date.now(),
    kind,
    actor: "user",
    payload,
  };
}

describe("buildTranscriptFromEvents", () => {
  it("replays user, tools, and assistant in order", () => {
    const entries = buildTranscriptFromEvents([
      ev("user_message", { text: "hi" }),
      ev("tool_call", { tool: "shell", args: { command: "ls" } }),
      ev("tool_result", { tool: "shell", result: { ok: true, stdout: "a\n", exitCode: 0 } }),
      ev("agent_message", { text: "Here you go." }),
    ]);
    expect(entries.map((e) => e.role)).toEqual(["user", "tool", "assistant"]);
    expect(entries[1]?.role === "tool" && entries[1].resultSummary).toBe("ok");
  });

  it("sets isError on failed results", () => {
    const entries = buildTranscriptFromEvents([
      ev("tool_call", { tool: "shell", args: { command: "false" } }),
      ev("tool_result", {
        tool: "shell",
        result: { ok: false, stdout: "", stderr: "failed\n", exitCode: 1 },
      }),
    ]);
    expect(entries[0]?.role === "tool" && entries[0].isError).toBe(true);
  });

  it("skips events with no relevant payload text", () => {
    const entries = buildTranscriptFromEvents([
      ev("user_message", { text: "   " }),
      ev("agent_message", { text: "" }),
    ]);
    expect(entries).toHaveLength(0);
  });

  it("increments group counter per user_message", () => {
    const entries = buildTranscriptFromEvents([
      ev("user_message", { text: "turn 1" }),
      ev("agent_message", { text: "answer 1" }),
      ev("user_message", { text: "turn 2" }),
      ev("agent_message", { text: "answer 2" }),
    ]);
    const groups = entries.map((e) => e.group);
    expect(groups[0]).toBe(1);
    expect(groups[2]).toBe(2);
    expect(groups[0]).toBeLessThan(groups[2]!);
  });

  it("patches tool result onto the matching pending tool entry", () => {
    const entries = buildTranscriptFromEvents([
      ev("tool_call", { tool: "read_file", args: { path: "/tmp/x.ts" } }),
      ev("tool_result", { tool: "read_file", result: { content: "const x = 1;\n" } }),
    ]);
    expect(entries).toHaveLength(1);
    const tool = entries[0];
    expect(tool?.role === "tool" && tool.resultSummary).toBeTruthy();
  });

  it("ignores unknown event kinds without throwing", () => {
    expect(() =>
      buildTranscriptFromEvents([
        ev("system_note" as Event["kind"], { type: "debug", message: "ignored" }),
      ])
    ).not.toThrow();
  });
});
