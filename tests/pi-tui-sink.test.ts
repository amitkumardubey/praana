import { describe, expect, it, mock } from "bun:test";
import { PiTuiSink, type SinkOpts } from "../src/ui/tui/sink.js";
import { TranscriptProjection } from "../src/ui/tui/transcript/projection.js";
import type { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
import type { ToastRegion } from "../src/ui/tui/toast-region.js";

function makeSink(extra: Partial<SinkOpts> = {}) {
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

  it("uses provider context for live usage and resets pending tool growth", () => {
    const onLiveContextUsage = mock((_: number) => {});
    const onProviderUsage = mock((_: unknown) => {});
    const { sink } = makeSink({
      onLiveContextUsage,
      onProviderUsage,
      ctxUsedTokens: () => 1000,
    });

    sink.nextGroup();
    sink.onProviderUsage({
      step: { input: 5000, output: 50, totalTokens: 5050 },
      cumulative: { input: 5000, output: 50, totalTokens: 5050 },
      latestContextTokens: 5000,
    });
    expect(onLiveContextUsage).toHaveBeenCalledWith(5000);

    sink.onToolResult("call-1", "shell", "x".repeat(40), false);
    expect(onLiveContextUsage).toHaveBeenLastCalledWith(5010);

    sink.onProviderUsage({
      step: { input: 8000, output: 120, totalTokens: 8120 },
      cumulative: { input: 13000, output: 170, totalTokens: 13170 },
      latestContextTokens: 8000,
    });
    expect(onLiveContextUsage).toHaveBeenLastCalledWith(8000);
    expect(onProviderUsage).toHaveBeenCalledTimes(2);
  });

  it("falls back to ctxUsedTokens before provider usage arrives", () => {
    const onLiveContextUsage = mock((_: number) => {});
    const { sink } = makeSink({
      onLiveContextUsage,
      ctxUsedTokens: () => 1000,
    });

    sink.nextGroup();
    sink.onToolResult("call-1", "shell", "x".repeat(40), false);
    expect(onLiveContextUsage).toHaveBeenCalledWith(1010);
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

  it("appends shell slash runs as tool rows with stdout/stderr/exit code", () => {
    const { sink, projection } = makeSink();
    sink.nextGroup();

    sink.appendShellRun({
      command: "echo hello",
      stdout: "hello",
      stderr: "",
      exitCode: 0,
      ok: true,
    });

    const entries = projection.entries();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.role).toBe("tool");
    expect(entry.toolName).toBe("shell");
    expect((entry as any).resultSummary).toBe("ok");
    expect((entry as any).resultBody).toBe("hello");
    expect((entry as any).isError).toBe(false);
  });
});
