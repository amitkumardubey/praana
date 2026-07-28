import { describe, expect, it, mock } from "bun:test";
import { PiTuiSink, type SinkOpts } from "../src/ui/tui/sink.js";
import { TranscriptProjection } from "../src/ui/tui/transcript/projection.js";
import type { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
import type { ToastRegion } from "../src/ui/tui/toast-region.js";
import type { ContextDisplaySnapshot } from "../src/context-display.js";

function baseline(overrides: Partial<ContextDisplaySnapshot> = {}): ContextDisplaySnapshot {
  return {
    usedTokens: 10_000,
    windowTokens: 100_000,
    pct: 10,
    mode: "engine",
    weightedTokens: 10_000,
    weightedPct: 10,
    rawTokens: 20_000,
    rawPct: 20,
    pressureMode: "normal",
    historyTokens: 1_000,
    ...overrides,
  };
}

function makeSink(extra: Partial<SinkOpts> = {}) {
  const projection = new TranscriptProjection({ useUnicode: true });
  const renderEntries = mock(() => {});
  const appendAssistantDelta = mock(() => true);
  const appendThinkingDelta = mock(() => true);
  const patchToolResult = mock(() => true);
  const persistEntry = mock(() => {});
  const onContextPreview = mock((_: ContextDisplaySnapshot) => {});
  const sink = new PiTuiSink(
    { requestRender: mock() } as never,
    {
      renderEntries,
      appendAssistantDelta,
      appendThinkingDelta,
      patchToolResult,
    } as unknown as TranscriptContainer,
    { show: mock() } as unknown as ToastRegion,
    {
      ambient: "inline",
      showThinking: () => true,
      onSpinnerMessage: mock(),
      ctxWindowTokens: 128_000,
      engineMode: true,
      onContextPreview,
      projection,
      persistEntry,
      ...extra,
    },
  );
  return {
    sink,
    projection,
    renderEntries,
    appendAssistantDelta,
    appendThinkingDelta,
    patchToolResult,
    persistEntry,
    onContextPreview,
  };
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

  it("projects multiple parallel tool calls as distinct rows", () => {
    const { sink, projection } = makeSink();
    sink.nextGroup();
    sink.appendUser("read both files");
    sink.onToolCallsStart();
    sink.onToolCall("call-1", "read_file", { path: "src/a.ts" });
    sink.onToolCall("call-2", "read_file", { path: "src/b.ts" });
    sink.onToolResult("call-1", "read_file", "file a content", false);
    sink.onToolResult("call-2", "read_file", "file b content", false);

    const toolEntries = projection.entries().filter((e) => e.role === "tool");
    expect(toolEntries).toHaveLength(2);
    expect(toolEntries.map((e) => e.id)).toEqual(["call-1", "call-2"]);
  });

  it("emits monotonic engine preview on history deltas", () => {
    const { sink, onContextPreview } = makeSink({ engineMode: true });
    sink.nextGroup();
    sink.onTurnContextBaseline(baseline({ usedTokens: 10_000, pct: 10, historyTokens: 1000 }));
    sink.onContextHistoryDelta({ tokensAdded: 500, source: "tool" });
    sink.onContextHistoryDelta({ tokensAdded: 300, source: "assistant" });
    expect(onContextPreview.mock.calls.length).toBeGreaterThanOrEqual(3);
    const last = onContextPreview.mock.calls.at(-1)?.[0] as ContextDisplaySnapshot;
    const first = onContextPreview.mock.calls[1]?.[0] as ContextDisplaySnapshot;
    expect(last.usedTokens).toBeGreaterThanOrEqual(first.usedTokens);
  });

  it("freezes classic preview during turn until commit", () => {
    const onContextPreview = mock((_: ContextDisplaySnapshot) => {});
    const { sink } = makeSink({ engineMode: false, onContextPreview });
    sink.nextGroup();
    sink.onTurnContextCommit(baseline({ mode: "classic", usedTokens: 8_000, pct: 8 }));
    sink.nextGroup();
    onContextPreview.mockClear();
    sink.onTurnContextBaseline(baseline({ mode: "classic", usedTokens: 12_000, pct: 12 }));
    sink.onContextHistoryDelta({ tokensAdded: 500, source: "tool" });
    expect(onContextPreview).not.toHaveBeenCalled();
    sink.onTurnContextCommit(baseline({ mode: "classic", usedTokens: 15_000, pct: 15 }));
    expect(onContextPreview).toHaveBeenCalledTimes(1);
  });

  it("keeps monotonic preview when commit snapshot is lower than live preview", () => {
    const { sink } = makeSink({ engineMode: true });
    sink.nextGroup();
    sink.onTurnContextBaseline(
      baseline({
        usedTokens: 15_000,
        pct: 15,
        weightedTokens: 15_000,
        weightedPct: 15,
        historyTokens: 1_000,
      }),
    );
    sink.onContextHistoryDelta({ tokensAdded: 3_000, source: "tool" });
    const live = sink.getContextPreview();
    expect(live?.pct).toBe(18);
    sink.onTurnContextCommit(
      baseline({
        usedTokens: 15_000,
        pct: 15,
        weightedTokens: 15_000,
        weightedPct: 15,
        historyTokens: 1_000,
      }),
    );
    expect(sink.getContextPreview()?.pct).toBe(18);
  });

  it("anchors footer ctx before to compile baseline, not the previous turn commit", () => {
    const { sink, projection } = makeSink({ engineMode: true });
    sink.onTurnContextCommit(
      baseline({
        usedTokens: 18_000,
        pct: 18,
        weightedTokens: 18_000,
        weightedPct: 18,
        historyTokens: 2_000,
      }),
    );
    sink.nextGroup();
    sink.appendUser("follow-up");
    sink.onTurnContextBaseline(
      baseline({
        usedTokens: 16_000,
        pct: 16,
        weightedTokens: 16_000,
        weightedPct: 16,
        historyTokens: 500,
      }),
    );
    sink.onContextHistoryDelta({ tokensAdded: 200, source: "assistant" });
    sink.appendTurnFooter(47_400);
    const footer = projection.entries().find((e) => e.role === "turn_footer");
    expect(footer?.text).toBeDefined();
    expect(footer!.text).not.toContain("18%w→");
    expect(footer!.text).toContain("16%w");
  });

  it("routes slash command output to the overlay callback", () => {
    const callback = mock((_: string[]) => {});
    const { sink } = makeSink({ onSlashCommandResult: callback });
    sink.onSlashCommandResult(["line 1", "line 2"]);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toEqual(["line 1", "line 2"]);
  });

  it("clearContextPreview drops the live preview snapshot", () => {
    const { sink } = makeSink();
    sink.onTurnContextBaseline(baseline({ pct: 42 }));
    expect(sink.getContextPreview()?.pct).toBe(42);

    sink.clearContextPreview();
    expect(sink.getContextPreview()).toBeNull();
  });

  it("compacts heavy transcript entries before persisting", () => {
    const { sink, persistEntry } = makeSink({
      persistCompaction: {
        persistThinkingMaxChars: 10,
        persistToolBodyMaxChars: 0,
      },
    });
    sink.nextGroup();
    sink.appendUser("hello");
    sink.onToolCallsStart();
    sink.onToolCall("call-1", "shell", { command: "cat big.log" });
    sink.onToolResult(
      "call-1",
      "shell",
      JSON.stringify({ ok: true, stdout: "a".repeat(10_000), stderr: "", exitCode: 0 }),
      false,
    );
    sink.onThinkingDelta("very long thinking block content");
    sink.onToolCallsStart();
    sink.appendTurnFooter(1000);

    const persisted = persistEntry.mock.calls.map((call) => call[0]);
    const thinking = persisted.find((entry) => entry.role === "thinking");
    const tool = persisted.find((entry) => entry.role === "tool");

    expect(thinking.text.length).toBeLessThanOrEqual(11);
    expect(tool.resultBody).toBeUndefined();
  });
});
