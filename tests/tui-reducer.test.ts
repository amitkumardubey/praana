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

  it("drops short pre-tool narration but keeps placeholder for flash prevention", () => {
    let state = createInitialTranscriptState();
    state = transcriptReducer(state, { type: "assistant_delta", delta: "Let me check" });
    expect(state.live?.text).toBe("Let me check");

    state = transcriptReducer(state, {
      type: "tool_call",
      toolName: "read_file",
      args: { path: "/tmp/foo.txt" },
    });
    expect(state.live?.role).toBe("assistant");
    expect(state.live?.text).toBe("");
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]?.role).toBe("tool");

    state = transcriptReducer(state, { type: "assistant_delta", delta: "The file shows " });
    expect(state.live?.text).toBe("The file shows ");
  });

  it("thinking_close creates assistant placeholder to prevent flash before tools", () => {
    let state = createInitialTranscriptState();
    state = transcriptReducer(state, { type: "thinking_delta", delta: "thinking..." });
    expect(state.live?.role).toBe("thinking");
    expect(state.live?.thinkingStartedAt).toBeTypeOf("number");

    // Real flow: thinking_close fires first (from onToolCallsStart)
    state = transcriptReducer(state, { type: "thinking_close" });
    // Thinking frozen to completed, empty assistant placeholder created
    expect(state.live?.role).toBe("assistant");
    expect(state.live?.text).toBe("");
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]?.role).toBe("thinking");
    expect(state.completed[0]?.durationMs).toBeTypeOf("number");

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

  it("does not freeze empty assistant placeholder when thinking starts after tools", () => {
    let state = createInitialTranscriptState();
    state = transcriptReducer(state, {
      type: "tool_call",
      toolName: "shell",
      args: { command: "ls" },
    });
    expect(state.live?.role).toBe("assistant");
    expect(state.live?.text).toBe("");

    state = transcriptReducer(state, { type: "thinking_delta", delta: "planning..." });
    expect(state.live?.role).toBe("thinking");
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]?.role).toBe("tool");
    expect(state.completed.some((e) => e.role === "assistant")).toBe(false);
  });

  it("records compact tool calls with display metadata", () => {
    const state = transcriptReducer(createInitialTranscriptState(), {
      type: "tool_call",
      toolName: "read_file",
      args: { path: "/tmp/foo.txt" },
    });
    expect(state.completed[0]?.role).toBe("tool");
    expect(state.completed[0]?.toolIcon).toBe("→");
    expect(state.completed[0]?.toolLabel).toContain("Read");
    expect(state.completed[0]?.toolLabel).toContain("foo.txt");
  });

  it("attaches tool_result summary to the matching tool entry", () => {
    let state = createInitialTranscriptState();
    state = transcriptReducer(state, {
      type: "tool_call",
      toolName: "read_file",
      args: { path: "/tmp/foo.txt" },
    });
    state = transcriptReducer(state, {
      type: "tool_result",
      toolName: "read_file",
      resultText: "line 1\nline 2\nline 3",
    });
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]?.role).toBe("tool");
    expect(state.completed[0]?.resultSummary).toContain("3 lines");
    expect(state.live?.role).toBe("assistant");
  });

  it("attaches shell result body to the matching tool entry", () => {
    let state = createInitialTranscriptState();
    state = transcriptReducer(state, {
      type: "tool_call",
      toolName: "shell",
      args: { command: "echo hello" },
    });
    state = transcriptReducer(state, {
      type: "tool_result",
      toolName: "shell",
      resultText: JSON.stringify({
        ok: true,
        stdout: "hello\nworld\n",
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]?.role).toBe("tool");
    expect(state.completed[0]?.toolName).toBe("shell");
    expect(state.completed[0]?.resultSummary).toContain("exit 0");
    expect(state.completed[0]?.resultBody).toBe("hello\nworld");
  });

  it("marks non-zero shell exit as error when turn passes isError false", () => {
    let state = createInitialTranscriptState();
    state = transcriptReducer(state, {
      type: "tool_call",
      toolName: "shell",
      args: { command: "false" },
    });
    state = transcriptReducer(state, {
      type: "tool_result",
      toolName: "shell",
      isError: false,
      resultText: JSON.stringify({
        ok: false,
        stdout: "",
        stderr: "command failed\n",
        exitCode: 1,
      }),
    });
    expect(state.completed[0]?.isError).toBe(true);
    expect(state.completed[0]?.resultSummary).toContain("exit 1");
  });

  it("falls back to orphan tool_result when no matching tool call exists", () => {
    const state = transcriptReducer(createInitialTranscriptState(), {
      type: "tool_result",
      toolName: "read_file",
      resultText: "orphan output",
    });
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0]?.role).toBe("tool_result");
    expect(state.completed[0]?.resultSummary).toContain("orphan output");
  });

  it("records turn footer with merged stats", () => {
    const state = transcriptReducer(createInitialTranscriptState(), {
      type: "turn_footer",
      model: "openrouter/big-pickle",
      durationMs: 1500,
      stats: {
        activeState: 1,
        totalState: 1,
        digestLen: 0,
        recallCalls: 0,
        recallHits: 0,
        autoHydrated: 0,
        promptTokens: 1000,
        outputTokens: 211,
      },
    });
    expect(state.completed[0]?.role).toBe("turn_footer");
    expect(state.completed[0]?.text).toBe(
      "▣ PRAANA · big-pickle · 1.5s · prompt ~1.0k · out ~211"
    );
  });

  it("does not freeze substantial assistant text when inserting tool_result between deltas", () => {
    let state = createInitialTranscriptState();
    const preamble =
      "Here is a longer explanation of what I found in the codebase before running the next command to verify the output. ";
    state = transcriptReducer(state, { type: "assistant_delta", delta: preamble });
    state = transcriptReducer(state, {
      type: "tool_call",
      toolName: "shell",
      args: { command: "ls" },
    });
    expect(state.live?.text).toBe(preamble);

    state = transcriptReducer(state, {
      type: "tool_result",
      toolName: "shell",
      resultText: "file1\nfile2",
    });
    expect(state.live?.text).toBe(preamble);

    state = transcriptReducer(state, { type: "assistant_delta", delta: "The result follows." });
    expect(state.live?.text).toBe(`${preamble}The result follows.`);
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
