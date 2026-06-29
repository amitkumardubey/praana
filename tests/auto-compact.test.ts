import { describe, it, expect, mock } from "bun:test";
import {
  eventsToSessionEvents,
  maybeAutoCompactClassic,
} from "../src/auto-compact.js";
import type { Event } from "../src/types.js";
import type { Session } from "../src/session.js";

function makeEvent(
  kind: Event["kind"],
  payload: Record<string, unknown>,
  id: string,
): Event {
  return {
    event_id: id,
    session_id: "sess-1",
    timestamp: Date.now(),
    kind,
    actor: kind === "user_message" ? "user" : "agent",
    payload,
  };
}

describe("auto-compact", () => {
  it("maps events to session events for summarisation", () => {
    const mapped = eventsToSessionEvents([
      makeEvent("user_message", { text: "hi" }, "e1"),
      makeEvent("tool_call", { tool: "shell", args: { command: "ls" } }, "e2"),
      makeEvent("tool_result", { tool: "shell", result: "ok" }, "e3"),
      makeEvent("agent_message", { text: "done" }, "e4"),
    ]);

    expect(mapped).toHaveLength(4);
    expect(mapped[1].type).toBe("tool_use");
    expect(mapped[2].type).toBe("tool_result");
  });

  it("does not compact when verbatim_only is set", async () => {
    const session = {
      config: {
        compiler: { verbatim_only: true, reserved_output_tokens: 0 },
        llm: { context_window: 10_000 },
      },
      memoryEnabled: true,
      memoryStore: { compressTurns: mock() },
      eventLog: {
        readAllUncompressed: mock(() => []),
        markEventsAsCompressed: mock(),
        append: mock(),
      },
      isCompactionArmed: () => false,
      setCompactionArmed: mock(),
      getContextWindowTokens: () => 10_000,
      debug: false,
    } as unknown as Session;

    const result = await maybeAutoCompactClassic(session, 900, "test/model");
    expect(result.compacted).toBe(false);
    expect(session.memoryStore!.compressTurns).not.toHaveBeenCalled();
  });

  it("compacts oldest events when pressure is high", async () => {
    const events = [
      makeEvent("user_message", { text: "1" }, "e0"),
      makeEvent("agent_message", { text: "a" }, "e1"),
      makeEvent("user_message", { text: "2" }, "e2"),
      makeEvent("agent_message", { text: "b" }, "e3"),
      makeEvent("user_message", { text: "3" }, "e4"),
      makeEvent("agent_message", { text: "c" }, "e5"),
    ];

    const compressTurns = mock().mockResolvedValue(2);
    const markEventsAsCompressed = mock();
    const append = mock();
    const setCompactionArmed = mock();

    const session = {
      config: {
        compiler: {
          auto_compact_at: 0.75,
          auto_compact_clear_at: 0.55,
          compact_chunk_fraction: 0.5,
          reserved_output_tokens: 0,
        },
        llm: { context_window: 10_000 },
      },
      memoryEnabled: true,
      memoryStore: { compressTurns },
      eventLog: {
        readAllUncompressed: mock(() => events),
        markEventsAsCompressed,
        append,
      },
      isCompactionArmed: () => false,
      setCompactionArmed,
      getContextWindowTokens: () => 10_000,
      debug: false,
    } as unknown as Session;

    const result = await maybeAutoCompactClassic(session, 8_000, "test/model");
    expect(result.compacted).toBe(true);
    expect(result.eventsCompacted).toBe(3);
    expect(compressTurns).toHaveBeenCalledOnce();
    expect(markEventsAsCompressed).toHaveBeenCalledWith(["e0", "e1", "e2"]);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "system_note",
        payload: expect.objectContaining({ type: "history_compacted" }),
      }),
    );
  });
});
