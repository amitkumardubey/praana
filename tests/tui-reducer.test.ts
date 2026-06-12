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

  it("keeps assistant live entry alive during tool calls to prevent flash", () => {
    let state = createInitialTranscriptState();
    // Start assistant streaming
    state = transcriptReducer(state, { type: "assistant_delta", delta: "Let me check" });
    expect(state.live?.role).toBe("assistant");
    expect(state.live?.text).toBe("Let me check");

    // Tool call should NOT freeze the assistant live entry
    state = transcriptReducer(state, {
      type: "tool_call",
      toolName: "read_file",
      args: { path: "/tmp/foo.txt" },
    });
    expect(state.live?.role).toBe("assistant");
    expect(state.live?.text).toBe("Let me check");
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]?.role).toBe("tool");

    // Next assistant delta appends to existing live entry
    state = transcriptReducer(state, { type: "assistant_delta", delta: " the file..." });
    expect(state.live?.text).toBe("Let me check the file...");
  });

  it("thinking_close creates assistant placeholder to prevent flash before tools", () => {
    let state = createInitialTranscriptState();
    state = transcriptReducer(state, { type: "thinking_delta", delta: "thinking..." });
    expect(state.live?.role).toBe("thinking");

    // Real flow: thinking_close fires first (from onToolCallsStart)
    state = transcriptReducer(state, { type: "thinking_close" });
    // Thinking frozen to completed, empty assistant placeholder created
    expect(state.live?.role).toBe("assistant");
    expect(state.live?.text).toBe("");
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]?.role).toBe("thinking");

    // Then tool_call adds entry without disrupting live placeholder
    state = transcriptReducer(state, {
      type: "tool_call",
      toolName: "read_file",
      args: { path: "/tmp/foo.txt" },
    });
    expect(state.live?.role).toBe("assistant");
    expect(state.live?.text).toBe("");
    expect(state.completed).toHaveLength(2);
    expect(state.completed[1]?.role).toBe("tool");

    // Next assistant delta fills the placeholder
    state = transcriptReducer(state, { type: "assistant_delta", delta: "The file shows " });
    expect(state.live?.text).toBe("The file shows ");
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

  it("appends tool_result as a distinct completed entry", () => {
    let state = createInitialTranscriptState();
    state = transcriptReducer(state, {
      type: "tool_result",
      toolName: "read_file",
      resultText: "line 1\nline 2\nline 3",
    });
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]?.role).toBe("tool_result");
    expect(state.completed[0]?.toolName).toBe("read_file");
    expect(state.completed[0]?.text).toBe("line 1\nline 2\nline 3");
    // Live entry should be unaffected
    expect(state.live).toBeNull();
  });

  it("does not freeze assistant when inserting tool_result between deltas", () => {
    let state = createInitialTranscriptState();
    state = transcriptReducer(state, { type: "assistant_delta", delta: "Here is " });
    state = transcriptReducer(state, {
      type: "tool_call",
      toolName: "shell",
      args: { command: "ls" },
    });
    expect(state.live?.text).toBe("Here is ");

    // Tool result doesn't affect live entry
    state = transcriptReducer(state, {
      type: "tool_result",
      toolName: "shell",
      resultText: "file1\nfile2",
    });
    expect(state.live?.text).toBe("Here is ");

    // Assistant continues
    state = transcriptReducer(state, { type: "assistant_delta", delta: "the result" });
    expect(state.live?.text).toBe("Here is the result");
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
