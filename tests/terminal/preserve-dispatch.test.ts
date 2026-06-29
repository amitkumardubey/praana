/**
 * Behavioural tests for runPreserveShell's watermark dispatch.
 *
 * We can't exercise the readline loop directly, but the core ordering
 * logic lives in the reducer + isEntryReady. These tests verify that a
 * turn's actions produce exactly the right committed-entry sequence without
 * duplicates or skips, which is what the watermark enforces.
 */
import { describe, it, expect } from "bun:test";
import {
  createInitialTranscriptState,
  transcriptReducer,
  type TranscriptAction,
  type TranscriptEntry,
  type TranscriptState,
} from "../../src/ui/chat-shell/reducer.js";

/** Mirror of isEntryReady in run.ts — keep in sync. */
function isEntryReady(entry: TranscriptEntry): boolean {
  return entry.role !== "tool" || entry.resultText !== undefined;
}

/**
 * Simulates the watermark loop: returns the entries that would be committed
 * (printed) after advancing from `committedCount` through `completed`.
 */
function drainReady(
  completed: TranscriptEntry[],
  committedCount: number
): { printed: TranscriptEntry[]; nextCount: number } {
  const printed: TranscriptEntry[] = [];
  let i = committedCount;
  while (i < completed.length) {
    const entry = completed[i]!;
    if (!isEntryReady(entry)) break;
    printed.push(entry);
    i++;
  }
  return { printed, nextCount: i };
}

/** Drive a sequence of actions, returning the list of printed entries. */
function simulateTurn(actions: TranscriptAction[]): {
  printed: TranscriptEntry[];
  liveUpdates: number;
} {
  let state: TranscriptState = createInitialTranscriptState();
  let committedCount = 0;
  let liveUpdates = 0;
  const printed: TranscriptEntry[] = [];

  for (const action of actions) {
    state = transcriptReducer(state, action);
    const { printed: batch, nextCount } = drainReady(state.completed, committedCount);
    printed.push(...batch);
    committedCount = nextCount;
    if (action.type === "assistant_delta" || action.type === "thinking_delta") {
      liveUpdates++;
    }
  }
  return { printed, liveUpdates };
}

describe("watermark dispatch: entry ordering", () => {
  it("commits user_message exactly once (not via manual + dispatch)", () => {
    const { printed } = simulateTurn([{ type: "user_message", text: "hello" }]);
    expect(printed).toHaveLength(1);
    expect(printed[0]!.role).toBe("user");
    expect(printed[0]!.text).toBe("hello");
  });

  it("commits assistant entry once on assistant_complete, not on deltas", () => {
    const { printed, liveUpdates } = simulateTurn([
      { type: "assistant_delta", delta: "Hi " },
      { type: "assistant_delta", delta: "there" },
      { type: "assistant_complete" },
    ]);
    expect(liveUpdates).toBe(2);
    expect(printed).toHaveLength(1);
    expect(printed[0]!.role).toBe("assistant");
    expect(printed[0]!.text).toBe("Hi there");
  });

  it("defers tool entry until resultText lands (no stub print)", () => {
    const midActions: TranscriptAction[] = [
      { type: "tool_call", toolName: "read_file", args: { path: "foo.ts" } },
    ];
    const { printed: midPrinted } = simulateTurn(midActions);
    // Tool entry is unready — nothing printed yet
    expect(midPrinted.filter((e) => e.role === "tool")).toHaveLength(0);

    const fullActions: TranscriptAction[] = [
      ...midActions,
      {
        type: "tool_result",
        toolName: "read_file",
        resultText: "// content",
      },
    ];
    const { printed: fullPrinted } = simulateTurn(fullActions);
    // After result lands the tool entry commits exactly once
    const toolPrints = fullPrinted.filter((e) => e.role === "tool");
    expect(toolPrints).toHaveLength(1);
    expect(toolPrints[0]!.resultText).toBe("// content");
  });

  it("prints tool entry with result before the final assistant entry", () => {
    const { printed } = simulateTurn([
      { type: "user_message", text: "q" },
      { type: "assistant_delta", delta: "Let me check" },
      { type: "tool_call", toolName: "shell", args: { command: "ls" } },
      { type: "tool_result", toolName: "shell", resultText: "file.ts" },
      { type: "assistant_delta", delta: "Done." },
      { type: "assistant_complete" },
      {
        type: "turn_footer",
        model: "test/m",
        durationMs: 100,
      },
    ]);
    const roles = printed.map((e) => e.role);
    // user → tool (with result) → assistant → turn_footer
    expect(roles).toEqual(["user", "tool", "assistant", "turn_footer"]);
    // Tool printed once — not twice (no stub + no duplicate from tool_result)
    expect(roles.filter((r) => r === "tool")).toHaveLength(1);
    // Assistant printed once
    expect(roles.filter((r) => r === "assistant")).toHaveLength(1);
  });

  it("handles assistant_complete no-op (empty live) without re-printing last entry", () => {
    // When assistant_complete fires but live is null or empty, the reducer is a
    // no-op — completed.length does not change, so the watermark doesn't move.
    const { printed } = simulateTurn([
      { type: "user_message", text: "hello" },
      { type: "assistant_complete" }, // no deltas → live is null → no-op
    ]);
    // Only the user message was committed; assistant_complete printed nothing
    expect(printed).toHaveLength(1);
    expect(printed[0]!.role).toBe("user");
  });

  it("handles thinking + assistant sequence correctly", () => {
    const { printed } = simulateTurn([
      { type: "thinking_delta", delta: "reasoning..." },
      { type: "thinking_close" },
      { type: "assistant_delta", delta: "answer" },
      { type: "assistant_complete" },
      { type: "turn_footer", model: "m", durationMs: 50 },
    ]);
    const roles = printed.map((e) => e.role);
    expect(roles).toEqual(["thinking", "assistant", "turn_footer"]);
  });

  it("turn_footer printed exactly once", () => {
    const { printed } = simulateTurn([
      { type: "assistant_delta", delta: "ok" },
      { type: "assistant_complete" },
      { type: "turn_footer", model: "m", durationMs: 42 },
    ]);
    expect(printed.filter((e) => e.role === "turn_footer")).toHaveLength(1);
  });
});

describe("watermark dispatch: interrupt resilience", () => {
  /**
   * Simulates the finally-block force-drain: after a turn ends (however it
   * ends), drain all remaining completed entries unconditionally.
   */
  function simulateTurnWithForceDrain(actions: TranscriptAction[]): TranscriptEntry[] {
    let state: TranscriptState = createInitialTranscriptState();
    let committedCount = 0;
    const printed: TranscriptEntry[] = [];

    for (const action of actions) {
      state = transcriptReducer(state, action);
      while (committedCount < state.completed.length) {
        const entry = state.completed[committedCount]!;
        if (!isEntryReady(entry)) break;
        printed.push(entry);
        committedCount++;
      }
    }

    // finally block: force-drain regardless of readiness
    while (committedCount < state.completed.length) {
      printed.push(state.completed[committedCount]!);
      committedCount++;
    }

    return printed;
  }

  it("prints stranded tool entry after interrupt (no tool_result)", () => {
    const printed = simulateTurnWithForceDrain([
      { type: "user_message", text: "run it" },
      { type: "tool_call", toolName: "shell", args: { command: "sleep 10" } },
      // TurnAbortedError — no tool_result arrives; finally runs force-drain
    ]);
    const roles = printed.map((e) => e.role);
    expect(roles).toContain("user");
    expect(roles).toContain("tool"); // stranded stub still surfaces
    expect(roles.filter((r) => r === "tool")).toHaveLength(1);
  });

  it("next turn prints normally after a prior interrupted tool", () => {
    let state: TranscriptState = createInitialTranscriptState();
    let committedCount = 0;
    const printed: TranscriptEntry[] = [];

    // Turn 1: tool call, then interrupt (no tool_result)
    const turn1: TranscriptAction[] = [
      { type: "user_message", text: "go" },
      { type: "tool_call", toolName: "shell", args: { command: "x" } },
    ];
    for (const action of turn1) {
      state = transcriptReducer(state, action);
      while (committedCount < state.completed.length) {
        const entry = state.completed[committedCount]!;
        if (!isEntryReady(entry)) break;
        printed.push(entry);
        committedCount++;
      }
    }
    // finally force-drain
    while (committedCount < state.completed.length) {
      printed.push(state.completed[committedCount]!);
      committedCount++;
    }

    // Turn 2: normal question, no tools
    const turn2: TranscriptAction[] = [
      { type: "user_message", text: "hello" },
      { type: "assistant_delta", delta: "Hi" },
      { type: "assistant_complete" },
    ];
    for (const action of turn2) {
      state = transcriptReducer(state, action);
      while (committedCount < state.completed.length) {
        const entry = state.completed[committedCount]!;
        if (!isEntryReady(entry)) break;
        printed.push(entry);
        committedCount++;
      }
    }
    // finally force-drain turn 2
    while (committedCount < state.completed.length) {
      printed.push(state.completed[committedCount]!);
      committedCount++;
    }

    const roles = printed.map((e) => e.role);
    // Turn 1: user + stranded tool; Turn 2: user + assistant — nothing frozen
    expect(roles.filter((r) => r === "user")).toHaveLength(2);
    expect(roles.filter((r) => r === "assistant")).toHaveLength(1);
    // The watermark advanced past the stranded tool, so turn 2 printed fully
    expect(roles.indexOf("assistant")).toBeGreaterThan(roles.lastIndexOf("tool"));
  });
});
