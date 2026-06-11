import { describe, expect, it } from "vitest";
import {
  createInitialTranscriptState,
  formatMemoryBannerLine,
  transcriptReducer,
} from "../src/ui/tui/reducer.js";

describe("transcriptReducer", () => {
  it("adds user messages to completed entries", () => {
    const state = transcriptReducer(createInitialTranscriptState(), {
      type: "user_message",
      text: "hello",
    });
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]?.role).toBe("user");
    expect(state.completed[0]?.text).toBe("hello");
  });

  it("streams assistant deltas into live entry then freezes on complete", () => {
    let state = createInitialTranscriptState();
    state = transcriptReducer(state, { type: "assistant_delta", delta: "Hi" });
    expect(state.live?.text).toBe("Hi");
    expect(state.completed).toHaveLength(0);

    state = transcriptReducer(state, { type: "assistant_delta", delta: " there" });
    expect(state.live?.text).toBe("Hi there");

    state = transcriptReducer(state, { type: "assistant_complete" });
    expect(state.live).toBeNull();
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]?.text).toBe("Hi there");
  });

  it("records compact tool calls", () => {
    const state = transcriptReducer(createInitialTranscriptState(), {
      type: "tool_call",
      toolName: "read_file",
      args: { path: "/tmp/foo.txt" },
    });
    expect(state.completed[0]?.role).toBe("tool");
    expect(state.completed[0]?.text).toContain("read_file");
    expect(state.completed[0]?.text).toContain("foo.txt");
  });

  it("formats memory banner line", () => {
    expect(
      formatMemoryBannerLine({
        activeState: 2,
        totalState: 5,
        digestLen: 0,
        recallCalls: 0,
        recallHits: 0,
        autoHydrated: 0,
        promptTokens: 100,
        outputTokens: 0,
      })
    ).toContain("state 2/5");
  });
});
