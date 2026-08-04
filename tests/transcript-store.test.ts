import { describe, expect, it } from "bun:test";
import { createTranscriptStore } from "../src/ui/tui/transcript/store.js";

describe("createTranscriptStore", () => {
  it("appends entries and streams assistant deltas", () => {
    const store = createTranscriptStore();
    store.mount.appendEntry({
      id: "a1",
      role: "assistant",
      group: 1,
      text: "Hi",
    });
    expect(store.mount.appendAssistantDelta("a1", " there")).toBe(true);
    expect(store.entries[0]!.text).toBe("Hi there");
    expect(store.streamingIds().has("a1")).toBe(true);
    store.mount.finalizeStreams?.(["a1"]);
    expect(store.streamingIds().has("a1")).toBe(false);
    store.dispose();
  });

  it("patches tool results in place", () => {
    const store = createTranscriptStore();
    store.mount.appendEntry({
      id: "t1",
      role: "tool",
      group: 1,
      toolName: "shell",
      toolIcon: "$",
      toolLabel: "shell",
      toolPending: "…",
    });
    expect(
      store.mount.patchToolResult("t1", {
        id: "t1",
        role: "tool",
        group: 1,
        toolName: "shell",
        toolIcon: "$",
        toolLabel: "shell",
        toolPending: "…",
        resultSummary: "ok",
        resultBody: "hello",
        isError: false,
      }),
    ).toBe(true);
    expect(store.entries[0]!.role).toBe("tool");
    if (store.entries[0]!.role === "tool") {
      expect(store.entries[0]!.resultSummary).toBe("ok");
    }
    store.dispose();
  });

  it("loadIndex and clear replace entries", () => {
    const store = createTranscriptStore();
    store.loadIndex({
      groups: [
        {
          group: 1,
          entries: [{ id: "u1", role: "user", group: 1, text: "hi" }],
        },
      ],
    });
    expect(store.entries.length).toBe(1);
    store.clear();
    expect(store.entries.length).toBe(0);
    store.dispose();
  });
});
