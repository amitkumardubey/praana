import { describe, it, expect } from "bun:test";
import type { Event } from "../src/types.js";
import {
  buildTranscriptFromEvents,
  compactTranscriptEntry,
  windowTranscriptEntries,
  type TranscriptEntry,
} from "../src/ui/tui/transcript/model.js";

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

  it("replays tool results by tool call id when available", () => {
    const entries = buildTranscriptFromEvents([
      ev("tool_call", { toolCallId: "a", tool: "shell", args: { command: "first" } }),
      ev("tool_call", { toolCallId: "b", tool: "shell", args: { command: "second" } }),
      ev("tool_result", {
        toolCallId: "b",
        tool: "shell",
        result: { ok: true, stdout: "second\n", stderr: "", exitCode: 0 },
      }),
      ev("tool_result", {
        toolCallId: "a",
        tool: "shell",
        result: { ok: true, stdout: "first\n", stderr: "", exitCode: 0 },
      }),
    ]);

    expect(entries[0]).toMatchObject({ id: "a", role: "tool", resultBody: "first" });
    expect(entries[1]).toMatchObject({ id: "b", role: "tool", resultBody: "second" });
  });

  it("replays multiple legacy tool results without tool call ids", () => {
    const entries = buildTranscriptFromEvents([
      ev("tool_call", { tool: "shell", args: { command: "first" } }),
      ev("tool_call", { tool: "shell", args: { command: "second" } }),
      ev("tool_result", {
        tool: "shell",
        result: { ok: true, stdout: "first\n", stderr: "", exitCode: 0 },
      }),
      ev("tool_result", {
        tool: "shell",
        result: { ok: true, stdout: "second\n", stderr: "", exitCode: 0 },
      }),
    ]);

    expect(entries[0]).toMatchObject({ id: "replay-tool-1", role: "tool", resultBody: "first" });
    expect(entries[1]).toMatchObject({ id: "replay-tool-2", role: "tool", resultBody: "second" });
  });

  it("ignores unknown event kinds without throwing", () => {
    expect(() =>
      buildTranscriptFromEvents([
        ev("system_note" as Event["kind"], { type: "debug", message: "ignored" }),
      ])
    ).not.toThrow();
  });

  it("replays persisted ui transcript entries", () => {
    const entries = buildTranscriptFromEvents([
      ev("ui_transcript", {
        type: "entry",
        entry: { id: "ui-footer-1", role: "turn_footer", group: 1, text: "1.0s · ctx 1%→2%" },
      }),
    ]);

    expect(entries).toEqual([
      { id: "ui-footer-1", role: "turn_footer", group: 1, text: "1.0s · ctx 1%→2%" },
    ]);
  });

  it("uses persisted ui transcript entries as authoritative when mixed with semantic events", () => {
    const entries = buildTranscriptFromEvents([
      ev("ui_transcript", {
        type: "entry",
        entry: { id: "ui-user-1", role: "user", group: 1, text: "hi" },
      }),
      ev("user_message", { text: "hi" }),
      ev("agent_message", { text: "legacy answer" }),
      ev("ui_transcript", {
        type: "entry",
        entry: { id: "ui-assistant-1", role: "assistant", group: 1, text: "projected answer" },
      }),
    ]);

    expect(entries).toEqual([
      { id: "ui-user-1", role: "user", group: 1, text: "hi" },
      { id: "ui-assistant-1", role: "assistant", group: 1, text: "projected answer" },
    ]);
  });

  it("windows persisted entries to the configured limit", () => {
    const entries = buildTranscriptFromEvents(
      [
        ev("ui_transcript", {
          type: "entry",
          entry: { id: "old-user", role: "user", group: 1, text: "old" },
        }),
        ev("ui_transcript", {
          type: "entry",
          entry: { id: "new-user", role: "user", group: 2, text: "new" },
        }),
      ],
      { window: { maxEntries: 1, maxChars: 10_000 } },
    );
    expect(entries).toEqual([
      { id: "new-user", role: "user", group: 2, text: "new" },
    ]);
  });

  it("keeps complete turns when windowing by entry count", () => {
    const entries = buildTranscriptFromEvents(
      [
        ev("ui_transcript", {
          type: "entry",
          entry: { id: "u1", role: "user", group: 1, text: "turn 1" },
        }),
        ev("ui_transcript", {
          type: "entry",
          entry: { id: "a1", role: "assistant", group: 1, text: "reply 1" },
        }),
        ev("ui_transcript", {
          type: "entry",
          entry: { id: "u2", role: "user", group: 2, text: "turn 2" },
        }),
        ev("ui_transcript", {
          type: "entry",
          entry: { id: "a2", role: "assistant", group: 2, text: "reply 2" },
        }),
      ],
      { window: { maxEntries: 3, maxChars: 10_000 } },
    );
    expect(entries.map((e) => e.id)).toEqual(["u2", "a2"]);
  });

  it("windows legacy replay results the same way", () => {
    const entries = buildTranscriptFromEvents(
      [
        ev("user_message", { text: "turn 1" }),
        ev("agent_message", { text: "reply 1" }),
        ev("user_message", { text: "turn 2" }),
        ev("agent_message", { text: "reply 2" }),
      ],
      { window: { maxEntries: 2, maxChars: 10_000 } },
    );
    expect(entries.map((e) => e.text)).toEqual(["turn 2", "reply 2"]);
  });
});

describe("compactTranscriptEntry", () => {
  it("truncates thinking text", () => {
    const entry: TranscriptEntry = {
      id: "t1",
      role: "thinking",
      group: 1,
      text: "a".repeat(10_000),
    };
    const compacted = compactTranscriptEntry(entry, {
      persistThinkingMaxChars: 100,
      persistToolBodyMaxChars: 0,
    });
    expect(compacted.text).toHaveLength(101);
    expect(compacted.text.endsWith("…")).toBe(true);
  });

  it("omits tool resultBody when max is zero", () => {
    const entry: TranscriptEntry = {
      id: "tool-1",
      role: "tool",
      group: 1,
      toolName: "shell",
      toolIcon: "❯",
      toolLabel: "ls",
      toolPending: "running…",
      resultSummary: "ok",
      resultBody: "line1\nline2\nline3",
    };
    const compacted = compactTranscriptEntry(entry, {
      persistThinkingMaxChars: 100,
      persistToolBodyMaxChars: 0,
    });
    expect(compacted.resultBody).toBeUndefined();
    expect(compacted.resultSummary).toBe("ok");
  });

  it("truncates tool resultBody when max is positive", () => {
    const entry: TranscriptEntry = {
      id: "tool-1",
      role: "tool",
      group: 1,
      toolName: "shell",
      toolIcon: "❯",
      toolLabel: "ls",
      toolPending: "running…",
      resultSummary: "ok",
      resultBody: "a".repeat(10_000),
    };
    const compacted = compactTranscriptEntry(entry, {
      persistThinkingMaxChars: 100,
      persistToolBodyMaxChars: 100,
    });
    expect(compacted.resultBody).toHaveLength(101);
  });

  it("leaves user entries unchanged", () => {
    const entry: TranscriptEntry = {
      id: "u1",
      role: "user",
      group: 1,
      text: "hello",
    };
    expect(compactTranscriptEntry(entry, {
      persistThinkingMaxChars: 10,
      persistToolBodyMaxChars: 0,
    })).toEqual(entry);
  });
});

describe("windowTranscriptEntries", () => {
  it("applies a char budget from the end while keeping turns whole", () => {
    const entries: TranscriptEntry[] = [
      { id: "u1", role: "user", group: 1, text: "aa" },
      { id: "a1", role: "assistant", group: 1, text: "bb" },
      { id: "u2", role: "user", group: 2, text: "cc" },
      { id: "a2", role: "assistant", group: 2, text: "dd" },
    ];
    const windowed = windowTranscriptEntries(entries, {
      maxEntries: 10,
      maxChars: 4,
    });
    expect(windowed.map((e) => e.id)).toEqual(["u2", "a2"]);
  });

  it("falls back to entry-count limit when char budget is large", () => {
    const entries: TranscriptEntry[] = [
      { id: "u1", role: "user", group: 1, text: "a" },
      { id: "u2", role: "user", group: 2, text: "b" },
      { id: "u3", role: "user", group: 3, text: "c" },
    ];
    const windowed = windowTranscriptEntries(entries, {
      maxEntries: 2,
      maxChars: 10_000,
    });
    expect(windowed.map((e) => e.id)).toEqual(["u2", "u3"]);
  });
});
