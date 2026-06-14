import { describe, expect, it } from "vitest";
import type { Event } from "../src/types.js";
import {
  buildTranscriptFromEvents,
  estimateEntryLines,
  sliceEntriesByLineBudget,
} from "../src/ui/tui/transcript-replay.js";

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
    expect(entries.map((e) => e.role)).toEqual([
      "user",
      "tool",
      "assistant",
    ]);
    expect(entries[1]?.resultSummary).toContain("exit 0");
    expect(entries[1]?.resultBody).toBe("a");
    expect(entries[1]?.toolIcon).toBe("$");
  });

  it("replays failed shell commands with error styling", () => {
    const entries = buildTranscriptFromEvents([
      ev("tool_call", { tool: "shell", args: { command: "false" } }),
      ev("tool_result", {
        tool: "shell",
        result: { ok: false, stdout: "", stderr: "failed\n", exitCode: 1 },
      }),
    ]);
    expect(entries[0]?.isError).toBe(true);
    expect(entries[0]?.resultBody).toContain("[stderr] failed");
  });
});

describe("estimateEntryLines", () => {
  it("counts shell result body lines in scroll budget", () => {
    const entry = {
      id: "e-1",
      role: "tool" as const,
      text: "shell",
      group: 1,
      resultSummary: "exit 0 · 3 line(s)",
      resultBody: "a\nb\nc",
    };
    expect(estimateEntryLines(entry)).toBe(5);
  });
});

describe("sliceEntriesByLineBudget", () => {
  it("returns all entries when under budget", () => {
    const entries = buildTranscriptFromEvents([
      ev("user_message", { text: "hello" }),
      ev("agent_message", { text: "world" }),
    ]);
    const slice = sliceEntriesByLineBudget(entries, 100, 0);
    expect(slice.entries).toHaveLength(2);
    expect(slice.maxScrollLines).toBe(0);
  });

  it("scrolls by line offset", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `e-${i}`,
      role: "assistant" as const,
      text: "line\n".repeat(10),
      group: 1,
    }));
    const base = sliceEntriesByLineBudget(entries, 12, 0);
    expect(base.maxScrollLines).toBeGreaterThan(0);
    expect(base.startIndex).toBeGreaterThan(0);
    const top = sliceEntriesByLineBudget(entries, 12, base.maxScrollLines);
    expect(top.startIndex).toBe(0);
    expect(top.entries.length).toBeGreaterThan(0);
  });
});
