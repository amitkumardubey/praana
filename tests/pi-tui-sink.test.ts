import { describe, expect, it, mock } from "bun:test";
import { PiTuiSink } from "../src/ui/tui/sink.js";
import { TranscriptProjection } from "../src/ui/tui/transcript/projection.js";
import type { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
import type { ToastRegion } from "../src/ui/tui/toast-region.js";

function makeSink(
  extra: { onSlashCommandResult?: (lines: string[]) => void } = {},
) {
  const projection = new TranscriptProjection({ useUnicode: true });
  const renderEntries = mock(() => {});
  const persistEntry = mock(() => {});
  const sink = new PiTuiSink(
    { requestRender: mock() } as never,
    { renderEntries } as unknown as TranscriptContainer,
    { show: mock() } as unknown as ToastRegion,
    {
      ambient: "inline",
      showThinking: () => true,
      onSpinnerMessage: mock(),
      ctxWindowTokens: 128_000,
      ctxUsedTokens: () => 0,
      projection,
      persistEntry,
      ...extra,
    },
  );
  return { sink, projection, renderEntries, persistEntry };
}

describe("PiTuiSink", () => {
  it("disables shell live streaming so output stays in the transcript", () => {
    const { sink } = makeSink();

    expect(sink.shellLiveStream).toBe(false);
  });

  it("projects text, thinking, tools, recall, and footer rows", () => {
    const { sink, projection, persistEntry } = makeSink();
    sink.nextGroup();
    sink.appendUser("hello");
    sink.onTextDelta("hi");
    sink.onThinkingDelta("plan");
    sink.onToolCallsStart();
    sink.onToolCall("call-1", "recall", { query: "hello" });
    sink.onToolResult(
      "call-1",
      "recall",
      JSON.stringify({ entries: [{ content: "remembered fact" }] }),
      false,
    );
    sink.onMemoryBanner({ recallCalls: 1, recallHits: 1, recallUsed: 0, memoryTokens: 0 });
    sink.appendTurnFooter(1000);

    expect(projection.entries().map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "thinking",
      "tool",
      "recall",
      "turn_footer",
    ]);
    expect(persistEntry).toHaveBeenCalled();
  });

  it("persists streaming assistant text before the footer when no tools run", () => {
    const { sink, persistEntry } = makeSink();
    sink.nextGroup();
    sink.appendUser("hello");
    sink.onTextDelta("hi");
    sink.appendTurnFooter(1000);

    expect(persistEntry.mock.calls.map((call) => call[0]?.role)).toEqual([
      "user",
      "assistant",
      "turn_footer",
    ]);
  });

  it("routes slash command output to the overlay callback", () => {
    const callback = mock((_: string[]) => {});
    const { sink } = makeSink({ onSlashCommandResult: callback });

    sink.onSlashCommandResult(["line 1", "line 2"]);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toEqual(["line 1", "line 2"]);
  });

  it("falls back to system lines when no slash overlay callback is set", () => {
    const { sink, projection } = makeSink();

    sink.onSlashCommandResult(["line 1", "line 2"]);

    const roles = projection.entries().map((entry) => entry.role);
    expect(roles).toEqual(["system", "system"]);
  });
});
