import { describe, expect, it } from "bun:test";
import { OpenTuiSink, type StreamBatchScheduler } from "../src/ui/tui/sink.js";
import { TranscriptProjection } from "../src/ui/tui/transcript/projection.js";
import { createTranscriptStore } from "../src/ui/tui/transcript/store.js";
import type { TranscriptMount } from "../src/ui/tui/transcript/mount.js";
import type { IndexedTranscriptEntry } from "../src/ui/tui/transcript/index.js";
import type { ToolEntry } from "../src/ui/tui/transcript/model.js";
import type { ToastApi } from "../src/ui/tui/shell-ui.js";

/** Deterministic virtual-clock scheduler: timers fire on advance(). */
class FakeScheduler implements StreamBatchScheduler {
  now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  schedule(fn: () => void, ms: number): { clear(): void } {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    return {
      clear: () => {
        this.timers.delete(id);
      },
    };
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error("negative advance");
    this.now += ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= this.now)
        .sort((a, b) => a[1].at - b[1].at);
      if (!due.length) return;
      for (const [id, t] of due) {
        if (this.timers.delete(id)) t.fn();
      }
    }
  }
}

type MountCall = { m: string; args: unknown[] };

/**
 * Records every transcript mount call (cloned) for call-sequence assertions.
 * Mirrors the real store semantics: appendAssistantDelta/appendThinkingDelta/
 * patchToolResult return false when the id is not yet known, so the sink falls
 * back to appendEntry (exactly like the Solid store).
 */
class RecordingMount implements TranscriptMount {
  calls: MountCall[] = [];
  private ids = new Set<string>();
  appendEntry(entry: IndexedTranscriptEntry): void {
    this.ids.add(entry.id);
    this.calls.push({ m: "appendEntry", args: [JSON.parse(JSON.stringify(entry))] });
  }
  appendAssistantDelta(id: string, delta: string): boolean {
    this.calls.push({ m: "appendAssistantDelta", args: [id, delta] });
    return this.ids.has(id);
  }
  appendThinkingDelta(id: string, delta: string): boolean {
    this.calls.push({ m: "appendThinkingDelta", args: [id, delta] });
    return this.ids.has(id);
  }
  patchToolResult(id: string, entry: ToolEntry): boolean {
    this.calls.push({ m: "patchToolResult", args: [id, JSON.parse(JSON.stringify(entry))] });
    return this.ids.has(id);
  }
  finalizeStreams(ids: Array<string | null | undefined>): void {
    this.calls.push({ m: "finalizeStreams", args: [ids] });
  }
}

function makeSink(opts: {
  streamBatchMs?: number;
  scheduler?: FakeScheduler;
  mount?: TranscriptMount;
  persist?: (e: unknown) => void;
  onSlashCommandResult?: (lines: string[]) => void;
}) {
  const mount = opts.mount ?? new RecordingMount();
  const persist: Array<{ m: string; args: unknown[] }> = [];
  const sink = new OpenTuiSink(mount, {} as unknown as ToastApi, {
    ambient: "inline",
    showThinking: () => true,
    onSpinnerMessage: () => {},
    ctxWindowTokens: 128_000,
    engineMode: false,
    projection: new TranscriptProjection({ useUnicode: false }),
    persistEntry: opts.persist ?? ((e) => persist.push({ m: "persist", args: [JSON.parse(JSON.stringify(e))] })),
    onSlashCommandResult: opts.onSlashCommandResult,
    streamBatchMs: opts.streamBatchMs ?? 0,
    batchScheduler: opts.scheduler,
  });
  return { sink, mount, persist };
}

describe("OpenTuiSink stream batching", () => {
  it("(a) with 0 the transcript mount call sequence matches today's", () => {
    const { sink, mount, persist } = makeSink({ streamBatchMs: 0 });

    sink.appendUser("hi");
    sink.onTextDelta("Hel");
    sink.onTextDelta("lo");
    sink.onToolCall("t1", "shell", { command: "ls" });
    sink.onToolResult("t1", "shell", "ok");
    sink.onThinkingDelta("Th");
    sink.onThinkingDelta("ink");
    sink.onFallback("notice");
    sink.appendTurnFooter(100);

    const call = (i: number) => mount.calls[i]!;
    const assistantId = call(1).args[0] as string;
    const thinkingId = call(6).args[0] as string;
    expect(mount.calls).toEqual([
      { m: "appendEntry", args: [{ id: "user-1-1", role: "user", group: 1, text: "hi" }] },
      // first assistant delta: appendAssistantDelta attempt misses, then fallback
      { m: "appendAssistantDelta", args: [assistantId, "Hel"] },
      { m: "appendEntry", args: [{ id: assistantId, role: "assistant", group: 1, text: "Hel" }] },
      { m: "appendAssistantDelta", args: [assistantId, "lo"] },
      { m: "appendEntry", args: [expect.objectContaining({ role: "tool", toolName: "shell" })] },
      { m: "patchToolResult", args: ["t1", expect.objectContaining({ role: "tool", resultText: "ok" })] },
      { m: "appendThinkingDelta", args: [thinkingId, "Th"] },
      { m: "appendEntry", args: [{ id: thinkingId, role: "thinking", group: 1, text: "Th" }] },
      { m: "appendThinkingDelta", args: [thinkingId, "ink"] },
      { m: "appendEntry", args: [expect.objectContaining({ role: "system", text: "notice" })] },
      { m: "finalizeStreams", args: [[assistantId, thinkingId]] },
      { m: "appendEntry", args: [expect.objectContaining({ role: "turn_footer" })] },
    ]);
    // Persistence order: each non-delta entry, then streams at finalize,
    // then footer — unchanged from today.
    expect(persist.map((p) => (p.args[0] as { role: string }).role)).toEqual([
      "user",
      "tool",
      "tool",
      "system",
      "assistant",
      "thinking",
      "turn_footer",
    ]);
  });

  it("(b) 20 deltas within one interval produce ONE append with concatenated text", () => {
    const scheduler = new FakeScheduler();
    const { sink, mount } = makeSink({ streamBatchMs: 33, scheduler });
    for (let i = 0; i < 20; i++) sink.onTextDelta("a");
    expect(mount.calls).toHaveLength(0);
    scheduler.advance(33);
    // one combined delta: miss attempt + single fallback append with the
    // concatenated text
    expect(mount.calls).toHaveLength(2);
    expect(mount.calls[0]).toEqual({ m: "appendAssistantDelta", args: [expect.any(String), "a".repeat(20)] });
    expect((mount.calls[1]!.args[0] as { role: string; text: string }).role).toBe("assistant");
    expect((mount.calls[1]!.args[0] as { text: string }).text).toBe("a".repeat(20));
    expect(scheduler.pendingTimers).toBe(0);
  });

  it("(c) every flush-before event flushes pending text first", () => {
    const scenarios: Array<{ name: string; run: (sink: OpenTuiSink) => void }> = [
      { name: "tool start", run: (s) => s.onToolCall("t1", "shell", { command: "ls" }) },
      { name: "tool finish", run: (s) => s.onToolResult("t1", "shell", "ok") },
      { name: "notice (onFallback)", run: (s) => s.onFallback("note") },
      { name: "status/error (onError warn)", run: (s) => s.onError({ level: "warn", domain: "fs", message: "boom" }) },
      { name: "turn footer", run: (s) => s.appendTurnFooter(50) },
      { name: "tool calls start (finalize)", run: (s) => s.onToolCallsStart() },
      { name: "appendShellRun", run: (s) => s.appendShellRun({ command: "ls", stdout: "", stderr: "", exitCode: 0, ok: true }) },
      { name: "nextGroup", run: (s) => s.nextGroup() },
      { name: "appendUser", run: (s) => s.appendUser("q") },
      { name: "step-pause (flushText)", run: (s) => s.flushText() },
      { name: "overlay (onSlashCommandResult)", run: (s) => s.onSlashCommandResult(["overlay"]) },
      { name: "memory banner nudge", run: (s) => s.onMemoryBanner({ activeState: 0, totalState: 0, digestLen: 0, recallCalls: 0, recallHits: 0, autoHydrated: 0, promptTokens: 0, outputTokens: 0, nudge: "nudge" }) },
      { name: "dispose", run: (s) => s.dispose() },
    ];
    for (const sc of scenarios) {
      const scheduler = new FakeScheduler();
      const { sink, mount } = makeSink({
        streamBatchMs: 33,
        scheduler,
      });
      sink.onTextDelta("x");
      sink.onTextDelta("y");
      sc.run(sink);
      // flush first: a single combined delta delivery (miss attempt + fallback
      // append) precedes anything the event itself touches
      expect(mount.calls[0], sc.name).toEqual({
        m: "appendAssistantDelta",
        args: [expect.any(String), "xy"],
      });
      expect(mount.calls[1], sc.name).toEqual({
        m: "appendEntry",
        args: [expect.objectContaining({ role: "assistant", text: "xy" })],
      });
    }

    // Also assert when a custom overlay callback is hooked: flush still precedes the callback
    const scheduler = new FakeScheduler();
    let flushedBeforeOverlay = false;
    const { sink, mount } = makeSink({
      streamBatchMs: 33,
      scheduler,
      onSlashCommandResult: () => {
        flushedBeforeOverlay = mount.calls.length >= 2;
      },
    });
    sink.onTextDelta("a");
    sink.onSlashCommandResult(["cmd output"]);
    expect(flushedBeforeOverlay).toBe(true);
  });

  it("(d) leading-edge timer flushes every interval during a long stream", () => {
    const scheduler = new FakeScheduler();
    const { sink, mount } = makeSink({ streamBatchMs: 33, scheduler });

    sink.onTextDelta("A"); // t=0 arms flush at t=33
    scheduler.advance(10);
    sink.onTextDelta("B");
    scheduler.advance(10);
    sink.onTextDelta("C");
    scheduler.advance(13); // t=33 → flush even though stream continues
    expect(mount.calls.map((c) => c.m)).toEqual(["appendAssistantDelta", "appendEntry"]);
    expect((mount.calls[1]!.args[0] as { text: string }).text).toBe("ABC");

    sink.onTextDelta("D"); // t=33 arms flush at t=66
    scheduler.advance(33); // t=66 → flush
    expect(mount.calls.map((c) => c.m)).toEqual([
      "appendAssistantDelta",
      "appendEntry",
      "appendAssistantDelta",
    ]);
    expect(mount.calls[2]!.args[1]).toBe("D");
    expect(scheduler.pendingTimers).toBe(0);
  });

  it("(e) dispose flushes pending text and leaves no timer", () => {
    const scheduler = new FakeScheduler();
    const { sink, mount } = makeSink({ streamBatchMs: 33, scheduler });
    sink.onTextDelta("p");
    sink.onTextDelta("q");
    expect(scheduler.pendingTimers).toBe(1);
    sink.dispose();
    expect(mount.calls.map((c) => c.m)).toEqual(["appendAssistantDelta", "appendEntry"]);
    expect((mount.calls[1]!.args[0] as { text: string }).text).toBe("pq");
    expect(scheduler.pendingTimers).toBe(0);
    scheduler.advance(10_000);
    expect(mount.calls).toHaveLength(2);
    sink.dispose(); // second dispose is a no-op
    expect(mount.calls).toHaveLength(2);
  });

  it("(f) alternating assistant/thinking deltas keep their relative order", () => {
    const scheduler = new FakeScheduler();
    const { sink, mount } = makeSink({ streamBatchMs: 33, scheduler });
    sink.onTextDelta("a1");
    sink.onThinkingDelta("t1");
    sink.onTextDelta("a2");
    sink.onThinkingDelta("t2");
    expect(mount.calls).toEqual([
      // assistant flush (thinking delta arrived on a different stream):
      // miss attempt + fallback append
      { m: "appendAssistantDelta", args: [expect.any(String), "a1"] },
      { m: "appendEntry", args: [{ id: expect.any(String), role: "assistant", group: 1, text: "a1" }] },
      // thinking flush (assistant delta arrived): miss attempt + fallback append
      { m: "appendThinkingDelta", args: [expect.any(String), "t1"] },
      { m: "appendEntry", args: [{ id: expect.any(String), role: "thinking", group: 1, text: "t1" }] },
      // assistant stream now exists: direct delta append
      { m: "appendAssistantDelta", args: [expect.any(String), "a2"] },
    ]);
    expect(scheduler.pendingTimers).toBe(1);
  });

  it("(g) final persisted entries equal the 0-ms run for the same event list", () => {
    const runAll = (sink: OpenTuiSink) => {
      sink.appendUser("hi");
      sink.onTextDelta("Hel");
      sink.onTextDelta("lo ");
      sink.onThinkingDelta("Th");
      sink.onToolCall("t1", "shell", { command: "ls" });
      sink.onTextDelta("world");
      sink.onThinkingDelta("ink");
      sink.onToolResult("t1", "shell", "ok");
      sink.onFallback("done");
      sink.appendTurnFooter(42);
    };

    const scheduler = new FakeScheduler();
    const batchedStore = createTranscriptStore();
    const unbatchedStore = createTranscriptStore();
    const batchedPersist: unknown[] = [];
    const unbatchedPersist: unknown[] = [];
    const batched = new OpenTuiSink(batchedStore.mount, {} as unknown as ToastApi, {
      ambient: "inline",
      showThinking: () => true,
      onSpinnerMessage: () => {},
      ctxWindowTokens: 128_000,
      engineMode: false,
      projection: new TranscriptProjection({ useUnicode: false }),
      persistEntry: (e) => batchedPersist.push(JSON.parse(JSON.stringify(e))),
      streamBatchMs: 33,
      batchScheduler: scheduler,
    });
    const unbatched = new OpenTuiSink(unbatchedStore.mount, {} as unknown as ToastApi, {
      ambient: "inline",
      showThinking: () => true,
      onSpinnerMessage: () => {},
      ctxWindowTokens: 128_000,
      engineMode: false,
      projection: new TranscriptProjection({ useUnicode: false }),
      persistEntry: (e) => unbatchedPersist.push(JSON.parse(JSON.stringify(e))),
      streamBatchMs: 0,
    });

    runAll(batched);
    // Let the batched timer fire mid-run; then dispose both.
    scheduler.advance(100);
    batched.dispose();
    runAll(unbatched);
    unbatched.dispose();

    expect(JSON.stringify(batchedPersist)).toBe(JSON.stringify(unbatchedPersist));
    expect(JSON.stringify(JSON.parse(JSON.stringify(batchedStore.entries)))).toBe(
      JSON.stringify(JSON.parse(JSON.stringify(unbatchedStore.entries))),
    );
    batchedStore.dispose();
    unbatchedStore.dispose();
  });

  it("batching is off by default (streamBatchMs unset)", () => {
    const scheduler = new FakeScheduler();
    const { sink, mount } = makeSink({ scheduler });
    sink.onTextDelta("a");
    sink.onTextDelta("b");
    expect(mount.calls.map((c) => c.m)).toEqual([
      "appendAssistantDelta",
      "appendEntry",
      "appendAssistantDelta",
    ]);
    expect(scheduler.pendingTimers).toBe(0);
  });

  it("deltas after dispose are ignored (no timer, no transcript change)", () => {
    const scheduler = new FakeScheduler();
    const { sink, mount } = makeSink({ streamBatchMs: 33, scheduler });
    sink.onTextDelta("a");
    sink.dispose();
    sink.onTextDelta("b");
    expect(mount.calls).toHaveLength(2);
    expect(scheduler.pendingTimers).toBe(0);
  });

  it("real transcript store keeps a consistent view with batching", () => {
    const scheduler = new FakeScheduler();
    const store = createTranscriptStore();
    const { sink } = makeSink({ streamBatchMs: 33, scheduler, mount: store.mount });
    sink.onTextDelta("one ");
    sink.onThinkingDelta("think ");
    sink.onTextDelta("two");
    scheduler.advance(33);
    const entries = JSON.parse(JSON.stringify(store.entries)) as Array<{ role: string; text: string; id: string }>;
    expect(entries.map((e) => e.role)).toEqual(["assistant", "thinking"]);
    expect(entries[0]!.text).toBe("one two");
    expect(entries[1]!.text).toBe("think ");
    // Streaming labels are only added on successful delta appends (first
    // delta of a stream lands via the appendEntry fallback), matching today.
    expect(store.streamingIds()).toEqual(new Set([entries[0]!.id]));
    store.dispose();
  });
});
