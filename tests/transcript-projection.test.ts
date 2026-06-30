import { describe, expect, it } from "bun:test";
import type { TranscriptEntry } from "../src/ui/tui/transcript/model.js";
import {
  isPersistedTuiTranscriptPayload,
  type PersistedTuiTranscriptPayload,
  type TuiTranscriptEvent,
} from "../src/ui/tui/transcript/events.js";
import { TranscriptProjection } from "../src/ui/tui/transcript/projection.js";

function textEvent(
  type: TuiTranscriptEvent["type"],
  overrides: Partial<Extract<TuiTranscriptEvent, { type: typeof type }>> = {},
): TuiTranscriptEvent {
  return {
    type,
    ...overrides,
  } as TuiTranscriptEvent;
}

describe("isPersistedTuiTranscriptPayload", () => {
  it("accepts the persisted transcript payload shape", () => {
    expect(
      isPersistedTuiTranscriptPayload({
        type: "entry",
        entry: { id: "u1", role: "user", group: 1, text: "hi" },
      }),
    ).toBe(true);
  });
});

describe("TranscriptProjection", () => {
  it("coalesces assistant and thinking deltas by id", () => {
    const projection = new TranscriptProjection({ useUnicode: true });

    projection.apply(textEvent("assistant_delta", { id: "a1", group: 2, delta: "Hel" }));
    projection.apply(textEvent("assistant_delta", { id: "a1", group: 2, delta: "lo" }));
    projection.apply(textEvent("thinking_delta", { id: "t1", group: 2, delta: "thin" }));
    projection.apply(textEvent("thinking_delta", { id: "t1", group: 2, delta: "king" }));

    expect(projection.entries()).toEqual([
      { id: "a1", role: "assistant", group: 2, text: "Hello" },
      { id: "t1", role: "thinking", group: 2, text: "thinking" },
    ] satisfies TranscriptEntry[]);
  });

  it("patches tool results by call id, not tool name", () => {
    const projection = new TranscriptProjection({ useUnicode: false });

    projection.apply(
      textEvent("tool_call_started", {
        id: "call-1",
        group: 4,
        toolName: "shell",
        args: { command: "bun test" },
      }),
    );
    projection.apply(
      textEvent("tool_call_started", {
        id: "call-2",
        group: 4,
        toolName: "shell",
        args: { command: "bun lint" },
      }),
    );
    projection.apply(
      textEvent("tool_call_finished", {
        id: "call-2",
        group: 4,
        toolName: "shell",
        resultText: JSON.stringify({ stdout: "2 pass\n0 fail\n", stderr: "", exitCode: 0 }),
        isError: false,
      }),
    );

    const entries = projection.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: "call-1", role: "tool", toolName: "shell" });
    expect(entries[1]).toMatchObject({
      id: "call-2",
      role: "tool",
      toolName: "shell",
      resultSummary: "2 pass · 0 fail",
    });
    expect(entries[0]?.group).toBe(4);
    expect(entries[1]?.group).toBe(4);
  });

  it("uses tool result args when started-call args are unavailable", () => {
    const projection = new TranscriptProjection({ useUnicode: true });

    projection.apply(
      textEvent("tool_call_started", {
        id: "edit-1",
        group: 5,
        toolName: "edit_file",
        args: {},
      }),
    );
    projection.apply(
      textEvent("tool_call_finished", {
        id: "edit-1",
        group: 5,
        toolName: "edit_file",
        resultText: JSON.stringify({ ok: true }),
        isError: false,
        args: { oldText: "one\ntwo", newText: "one\ntwo\nthree" },
      }),
    );

    expect(projection.entries()[0]).toMatchObject({
      id: "edit-1",
      role: "tool",
      resultSummary: "+3 −2",
    });
  });

  it("loads existing entries and appends later projection events in order", () => {
    const projection = new TranscriptProjection({ useUnicode: true });
    projection.load([
      { id: "u1", role: "user", group: 1, text: "previous" },
    ]);

    projection.apply(textEvent("assistant_delta", { id: "a1", group: 2, delta: "next" }));

    expect(projection.entries()).toEqual([
      { id: "u1", role: "user", group: 1, text: "previous" },
      { id: "a1", role: "assistant", group: 2, text: "next" },
    ] satisfies TranscriptEntry[]);
  });

  it("emits visible transcript concepts and clears state", () => {
    const projection = new TranscriptProjection({ useUnicode: true });

    projection.apply(textEvent("turn_started", { group: 7 }));
    projection.apply(textEvent("user_submitted", { id: "u1", text: "hi", group: 7 }));
    projection.apply(textEvent("assistant_delta", { id: "a1", group: 7, delta: "reply" }));
    projection.apply(textEvent("thinking_delta", { id: "t1", group: 7, delta: "brain" }));
    projection.apply(textEvent("tool_call_started", { id: "c1", group: 7, toolName: "recall", args: { query: "q" } }));
    projection.apply(
      textEvent("tool_call_finished", {
        id: "c1",
        group: 7,
        toolName: "recall",
        resultText: JSON.stringify({ ok: true, entries: [{ id: "r1", content: "match" }] }),
        isError: false,
      }),
    );
    projection.apply(textEvent("recall_chip", { id: "r1", group: 7, query: "q", preview: "match", count: 1 }));
    projection.apply(textEvent("system_line", { id: "s1", group: 7, text: "warning" }));
    projection.apply(textEvent("turn_footer", { id: "f1", group: 7, text: "✓ 10ms" }));
    projection.apply(textEvent("streams_finalized", { group: 7 }));

    expect(projection.entries().map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "thinking",
      "tool",
      "recall",
      "system",
      "turn_footer",
    ]);
    expect(projection.entries().every((entry) => entry.group === 7)).toBe(true);

    projection.apply(textEvent("transcript_cleared"));
    expect(projection.entries()).toEqual([]);
  });
});
