import { describe, it, expect } from "bun:test";
import type { Event } from "../src/types.js";
import {
  buildTranscriptIndex,
  resolveExpandedContent,
} from "../src/ui/tui/transcript/index.js";

function ev(kind: Event["kind"], payload: Record<string, unknown>): Event {
  return {
    event_id: `ev_${kind}_${Math.random().toString(36).slice(2, 8)}`,
    session_id: "sess",
    timestamp: Date.now(),
    kind,
    actor: "user",
    payload,
  };
}

describe("buildTranscriptIndex", () => {
  it("groups persisted transcript entries by turn", () => {
    const index = buildTranscriptIndex([
      ev("ui_transcript", {
        type: "entry",
        entry: { id: "u1", role: "user", group: 1, text: "hi" },
      }),
      ev("ui_transcript", {
        type: "entry",
        entry: { id: "a1", role: "assistant", group: 1, text: "hello" },
      }),
      ev("ui_transcript", {
        type: "entry",
        entry: { id: "u2", role: "user", group: 2, text: "bye" },
      }),
    ]);

    expect(index.groups).toHaveLength(2);
    expect(index.groups[0]!.entries.map((e) => e.id)).toEqual(["u1", "a1"]);
    expect(index.groups[1]!.entries.map((e) => e.id)).toEqual(["u2"]);
  });

  it("links tool entries to their tool_result source events by call id", () => {
    const toolResult = ev("tool_result", {
      toolCallId: "call-1",
      tool: "read_file",
      result: { content: "file contents here" },
    });
    const index = buildTranscriptIndex([
      ev("ui_transcript", {
        type: "entry",
        entry: {
          id: "call-1",
          role: "tool",
          group: 1,
          toolName: "read_file",
          toolIcon: "◇",
          toolLabel: "read src/a.ts",
          toolPending: "running…",
          resultSummary: "ok",
        },
      }),
      toolResult,
    ]);

    const tool = index.groups[0]!.entries.find((e) => e.role === "tool");
    expect(tool?.sourceEventId).toBe(toolResult.event_id);
    expect(tool?.expandable).toBe(true);
  });

  it("links legacy tool entries to tool_result events in order", () => {
    const resultA = ev("tool_result", {
      tool: "shell",
      result: { ok: true, stdout: "a", stderr: "", exitCode: 0 },
    });
    const resultB = ev("tool_result", {
      tool: "shell",
      result: { ok: true, stdout: "b", stderr: "", exitCode: 0 },
    });
    const index = buildTranscriptIndex([
      ev("tool_call", { tool: "shell", args: { command: "first" } }),
      ev("tool_call", { tool: "shell", args: { command: "second" } }),
      resultA,
      resultB,
    ]);

    const tools = index.groups[0]!.entries.filter((e) => e.role === "tool");
    expect(tools[0]?.sourceEventId).toBe(resultA.event_id);
    expect(tools[1]?.sourceEventId).toBe(resultB.event_id);
  });

  it("preserves full thinking text from persisted entries", () => {
    const longThinking = "thinking\n".repeat(1000);
    const index = buildTranscriptIndex([
      ev("ui_transcript", {
        type: "entry",
        entry: { id: "t1", role: "thinking", group: 1, text: longThinking },
      }),
    ]);

    const thinking = index.groups[0]!.entries[0];
    expect(thinking?.role).toBe("thinking");
    expect(thinking?.text).toBe(longThinking);
    expect(thinking?.expandable).toBe(true);
  });

  it("sorts groups by group number", () => {
    const index = buildTranscriptIndex([
      ev("ui_transcript", {
        type: "entry",
        entry: { id: "u3", role: "user", group: 3, text: "third" },
      }),
      ev("ui_transcript", {
        type: "entry",
        entry: { id: "u1", role: "user", group: 1, text: "first" },
      }),
      ev("ui_transcript", {
        type: "entry",
        entry: { id: "u2", role: "user", group: 2, text: "second" },
      }),
    ]);

    expect(index.groups.map((g) => g.group)).toEqual([1, 2, 3]);
  });
});

describe("resolveExpandedContent", () => {
  it("returns thinking text verbatim", () => {
    const result = resolveExpandedContent(
      { id: "t1", role: "thinking", group: 1, text: "plan", expandable: true },
      [],
    );
    expect(result).toEqual({ ok: true, text: "plan" });
  });

  it("expands tool result content", () => {
    const source = ev("tool_result", {
      toolCallId: "call-1",
      tool: "read_file",
      result: { content: "full file body" },
    });
    const result = resolveExpandedContent(
      {
        id: "call-1",
        role: "tool",
        group: 1,
        toolName: "read_file",
        toolIcon: "◇",
        toolLabel: "read src/a.ts",
        toolPending: "running…",
        sourceEventId: source.event_id,
        expandable: true,
      },
      [source],
    );
    expect(result).toEqual({ ok: true, text: "full file body" });
  });

  it("expands shell stdout and stderr", () => {
    const source = ev("tool_result", {
      toolCallId: "call-1",
      tool: "shell",
      result: { ok: true, stdout: "out", stderr: "err", exitCode: 0 },
    });
    const result = resolveExpandedContent(
      {
        id: "call-1",
        role: "tool",
        group: 1,
        toolName: "shell",
        toolIcon: "❯",
        toolLabel: "true",
        toolPending: "running…",
        sourceEventId: source.event_id,
        expandable: true,
      },
      [source],
    );
    expect(result.ok && result.text).toContain("out");
    expect(result.ok && result.text).toContain("[stderr] err");
  });

  it("returns an error when the source event is missing", () => {
    const result = resolveExpandedContent(
      {
        id: "call-1",
        role: "tool",
        group: 1,
        toolName: "read_file",
        toolIcon: "◇",
        toolLabel: "read src/a.ts",
        toolPending: "running…",
        sourceEventId: "missing",
        expandable: true,
      },
      [],
    );
    expect(result.ok).toBe(false);
  });

  it("returns an error for non-expandable entries", () => {
    const result = resolveExpandedContent(
      { id: "u1", role: "user", group: 1, text: "hi" },
      [],
    );
    expect(result.ok).toBe(false);
  });
});
