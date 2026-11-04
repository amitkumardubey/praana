/**
 * Seeded randomized invariants for TUI stream-delta batching.
 *
 * Invariants (checked against an unbatched reference sink fed the same events):
 *   I1 no text lost/duplicated: after any event sequence plus final flush/
 *      dispose, transcript and persisted entries equal the unbatched run.
 *   I2 prefix-consistency at every observation point: the batched transcript
 *      is never ahead of or reordered relative to the unbatched run; only the
 *      single pending stream entry may lag by prefix text.
 *   I3 liveness: any pending delta is flushed within batchMs of the first
 *      unflushed delta; after the last event + batchMs nothing is pending.
 *   I4 no timer outlives dispose; no flush after dispose; never >1 timer;
 *      no pending without a timer and no idle timer.
 *   I5 batch 0 is a pure pass-through.
 */
import { describe, expect, it } from "bun:test";
import { OpenTuiSink, type StreamBatchScheduler } from "../../src/ui/tui/sink.js";
import { TranscriptProjection } from "../../src/ui/tui/transcript/projection.js";
import { createTranscriptStore, type TranscriptStoreApi } from "../../src/ui/tui/transcript/store.js";
import type { TranscriptMount } from "../../src/ui/tui/transcript/mount.js";
import type { IndexedTranscriptEntry } from "../../src/ui/tui/transcript/index.js";
import type { ToolEntry } from "../../src/ui/tui/transcript/model.js";
import type { ToastApi } from "../../src/ui/tui/shell-ui.js";
import { formatTurnFooterDigest } from "../../src/ui/tui/tool-icons.js";

export const BATCH_MS = 33;
export const SEEDS = 300;

class FakeScheduler implements StreamBatchScheduler {
  now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  schedule(fn: () => void, ms: number): { clear(): void } {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    return { clear: () => void this.timers.delete(id) };
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

/** Counts delta text deliveries to the transcript (observable flush marker). */
class SpyMount implements TranscriptMount {
  deltaApplies = 0;
  constructor(private readonly inner: TranscriptMount) {}
  appendEntry(entry: IndexedTranscriptEntry): void {
    if (entry.role === "assistant" || entry.role === "thinking") this.deltaApplies++;
    this.inner.appendEntry(entry);
  }
  appendAssistantDelta(id: string, delta: string): boolean {
    this.deltaApplies++;
    return this.inner.appendAssistantDelta(id, delta);
  }
  appendThinkingDelta(id: string, delta: string): boolean {
    this.deltaApplies++;
    return this.inner.appendThinkingDelta(id, delta);
  }
  patchToolResult(id: string, entry: ToolEntry): boolean {
    return this.inner.patchToolResult(id, entry);
  }
  finalizeStreams(ids: Array<string | null | undefined>): void {
    this.inner.finalizeStreams?.(ids);
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Op =
  | { kind: "user" }
  | { kind: "adelta" }
  | { kind: "tdelta" }
  | { kind: "toolstart" }
  | { kind: "toolfinish" }
  | { kind: "notice" }
  | { kind: "warn" }
  | { kind: "footer" }
  | { kind: "pause" }
  | { kind: "turn" }
  | { kind: "toolgo" }
  | { kind: "advance"; ms: number }
  | { kind: "dispose" };

const TEXT_POOL = ["a", "bc", "def", " gh", "i", "jk", "lmn", "opq ", "rs", "tuv", "w", "xyz"];

interface SinkLike {
  appendUser(text: string): void;
  onTextDelta(delta: string): void;
  onThinkingDelta(delta: string): void;
  onToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void;
  onToolResult(toolCallId: string, toolName: string, resultText: string, isError?: boolean): void;
  onFallback(text: string): void;
  onError(entry: { level: string; domain: string; message: string }): void;
  appendTurnFooter(durationMs: number): void;
  flushText(): void;
  nextGroup(): void;
  onToolCallsStart(): void;
  dispose(): void;
}

type Snapshot = { entries: Array<Record<string, unknown>>; streamingIds: string[] };

interface Pair {
  batched: SinkLike;
  ref: SinkLike;
  scheduler: FakeScheduler;
  batchedStore: TranscriptStoreApi;
  refStore: TranscriptStoreApi;
  spy: SpyMount;
  batchedPersist: unknown[];
  refPersist: unknown[];
}

export function snapshotStore(store: TranscriptStoreApi): Snapshot {
  return {
    entries: JSON.parse(JSON.stringify(store.entries)) as Array<Record<string, unknown>>,
    streamingIds: [...store.streamingIds()],
  };
}

const entryKey = (e: Record<string, unknown>) =>
  `${String(e.id)}|${String(e.role)}|${String(e.group)}|${String(e.text ?? "")}`;

export function makePair(batchMs: number, makeBatched: (mount: TranscriptMount, persist: (e: unknown) => void, scheduler: FakeScheduler) => SinkLike): Pair {
  const scheduler = new FakeScheduler();
  const batchedStore = createTranscriptStore();
  const refStore = createTranscriptStore();
  const spy = new SpyMount(batchedStore.mount);
  const batchedPersist: unknown[] = [];
  const refPersist: unknown[] = [];
  const ref = new OpenTuiSink(refStore.mount, {} as unknown as ToastApi, {
    ambient: "inline",
    showThinking: () => true,
    onSpinnerMessage: () => {},
    ctxWindowTokens: 128_000,
    engineMode: false,
    projection: new TranscriptProjection({ useUnicode: false }),
    persistEntry: (e) => refPersist.push(JSON.parse(JSON.stringify(e))),
    streamBatchMs: 0,
  });
  return {
    batched: makeBatched(spy, (e) => batchedPersist.push(JSON.parse(JSON.stringify(e))), scheduler),
    ref,
    scheduler,
    batchedStore,
    refStore,
    spy,
    batchedPersist,
    refPersist,
  };
}

function textFor(rand: () => number): string {
  return TEXT_POOL[Math.floor(rand() * TEXT_POOL.length)]!;
}

export function feedOp(p: Pair, op: Op, seq: number, rand: () => number): void {
  switch (op.kind) {
    case "user": {
      const text = `u${seq}`;
      p.batched.appendUser(text);
      p.ref.appendUser(text);
      break;
    }
    case "adelta": {
      const text = textFor(rand);
      p.batched.onTextDelta(text);
      p.ref.onTextDelta(text);
      break;
    }
    case "tdelta": {
      const text = textFor(rand);
      p.batched.onThinkingDelta(text);
      p.ref.onThinkingDelta(text);
      break;
    }
    case "toolstart": {
      const id = `t${seq}`;
      p.batched.onToolCall(id, "shell", { command: "ls" });
      p.ref.onToolCall(id, "shell", { command: "ls" });
      break;
    }
    case "toolfinish": {
      const id = `t${seq}`;
      p.batched.onToolResult(id, "shell", "ok");
      p.ref.onToolResult(id, "shell", "ok");
      break;
    }
    case "notice": {
      const text = `note ${seq}`;
      p.batched.onFallback(text);
      p.ref.onFallback(text);
      break;
    }
    case "warn": {
      const entry = { level: "warn" as const, domain: "fs", message: `w${seq}` };
      p.batched.onError(entry);
      p.ref.onError(entry);
      break;
    }
    case "footer": {
      p.batched.appendTurnFooter(10 + seq);
      p.ref.appendTurnFooter(10 + seq);
      break;
    }
    case "pause": {
      p.batched.flushText();
      p.ref.flushText();
      break;
    }
    case "turn": {
      p.batched.nextGroup();
      p.ref.nextGroup();
      break;
    }
    case "toolgo": {
      p.batched.onToolCallsStart();
      p.ref.onToolCallsStart();
      break;
    }
    case "advance": {
      p.scheduler.advance(op.ms);
      break;
    }
    case "dispose": {
      p.batched.dispose();
      p.ref.dispose();
      break;
    }
  }
}

type ConsistentResult =
  | { ok: true; role: "assistant" | "thinking" | null }
  | { ok: false; error: string };

/**
 * I2: prefix-consistency. Returns the single lagging stream role (or null)
 * when the batched transcript is a prefix-consistent view of the reference,
 * or an error when it is not. The pending stream entry may be missing
 * entirely (first delta still buffered) or carry a prefix of the reference
 * text; nothing else may differ.
 */
function consistentWithReference(batched: Snapshot, ref: Snapshot): ConsistentResult {
  if (batched.entries.length > ref.entries.length) return { ok: false, error: "batched ahead" };
  const streamingOk = () =>
    batched.streamingIds.every((id) => ref.streamingIds.includes(id));
  const keysEqual = (a: Array<Record<string, unknown>>, b: Array<Record<string, unknown>>) =>
    a.length === b.length && a.every((e, i) => entryKey(e) === entryKey(b[i]!));

  // If exactly one entry is missing from the batched transcript it must be
  // the last same-role stream entry (the not-yet-created pending entry).
  const missing = ref.entries.filter((e) => !batched.entries.some((b) => b.id === e.id));
  if (missing.length > 1) return { ok: false, error: "multiple missing entries" };
  if (missing.length === 1) {
    const m = missing[0]!;
    if (m.role !== "assistant" && m.role !== "thinking") return { ok: false, error: "missing non-stream entry" };
    const lastIdx = ref.entries.map((e) => e.role).lastIndexOf(m.role);
    if (ref.entries[lastIdx] !== m) return { ok: false, error: "missing entry is not the pending one" };
    const reduced = ref.entries.filter((e) => e.id !== m.id);
    if (!keysEqual(batched.entries, reduced)) return { ok: false, error: "diverged beyond pending entry" };
    return streamingOk() ? { ok: true, role: m.role as "assistant" | "thinking" } : { ok: false, error: "batched streaming id not in reference" };
  }

  let lagRole: "assistant" | "thinking" | null = null;
  for (let i = 0; i < batched.entries.length; i++) {
    const b = batched.entries[i]!;
    const r = ref.entries[i]!;
    if (b.id !== r.id) return { ok: false, error: "reordered relative to reference" };
    if (b.role === "assistant" || b.role === "thinking") {
      const bt = String(b.text ?? "");
      const rt = String(r.text ?? "");
      if (!rt.startsWith(bt)) return { ok: false, error: "pending text not a prefix of reference" };
      if (bt.length < rt.length) {
        if (lagRole && lagRole !== b.role) return { ok: false, error: "multiple lagging streams" };
        lagRole = b.role as "assistant" | "thinking";
      } else if (bt.length > rt.length) {
        return { ok: false, error: "batched text ahead of reference" };
      }
    } else if (entryKey(b) !== entryKey(r)) {
      return { ok: false, error: "non-stream entry diverged" };
    }
  }
  return streamingOk() ? { ok: true, role: lagRole } : { ok: false, error: "batched streaming id not in reference" };
}

export function generateOps(rand: () => number, length: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < length; i++) {
    const r = rand();
    if (r < 0.04) ops.push({ kind: "user" });
    else if (r < 0.29) ops.push({ kind: "adelta" });
    else if (r < 0.47) ops.push({ kind: "tdelta" });
    else if (r < 0.53) ops.push({ kind: "toolstart" });
    else if (r < 0.59) ops.push({ kind: "toolfinish" });
    else if (r < 0.65) ops.push({ kind: "notice" });
    else if (r < 0.69) ops.push({ kind: "warn" });
    else if (r < 0.74) ops.push({ kind: "footer" });
    else if (r < 0.78) ops.push({ kind: "pause" });
    else if (r < 0.81) ops.push({ kind: "turn" });
    else if (r < 0.84) ops.push({ kind: "toolgo" });
    else {
      const ms = rand() < 0.15 ? Math.floor(rand() * 400) : Math.floor(rand() * 2 * BATCH_MS);
      ops.push({ kind: "advance", ms });
    }
  }
  return ops;
}

interface RunState {
  lagRole: "assistant" | "thinking" | null;
  pendingSince: number;
  disposed: boolean;
}

export function runScenario(seed: number, batchMs: number, ops: Op[], makeBatched: (mount: TranscriptMount, persist: (e: unknown) => void, scheduler: FakeScheduler) => SinkLike): string[] {
  const rand = mulberry32(seed);
  const p = makePair(batchMs, makeBatched);
  const failures: string[] = [];
  const st: RunState = { lagRole: null, pendingSince: 0, disposed: false };

  const check = (op: Op, seq: number, phase: string) => {
    const b = snapshotStore(p.batchedStore);
    const r = snapshotStore(p.refStore);
    const lag = consistentWithReference(b, r);
    if (!lag.ok) {
      failures.push(`${phase} I2 seq${seq}: ${lag.error}`);
      st.lagRole = null;
      return;
    }
    if (lag.role !== st.lagRole) {
      st.lagRole = lag.role;
      if (lag.role) st.pendingSince = p.scheduler.now;
    }
    // I4: pending and timer must be paired; never two timers.
    if (p.scheduler.pendingTimers > 1) failures.push(`${phase} I4 seq${seq}: ${p.scheduler.pendingTimers} concurrent timers`);
    if (lag.role && p.scheduler.pendingTimers === 0 && !st.disposed) {
      failures.push(`${phase} I4 seq${seq}: pending without timer`);
    }
    if (!lag.role && p.scheduler.pendingTimers > 0 && !st.disposed) {
      failures.push(`${phase} I4 seq${seq}: idle timer with no pending`);
    }
    // I3: liveness — overdue pending is a violation.
    if (lag.role && p.scheduler.now - st.pendingSince >= batchMs) {
      failures.push(`${phase} I3 seq${seq}: overdue pending (${lag.role}) since clock ${st.pendingSince}, now ${p.scheduler.now}`);
    }
    // I2: after non-delta events the transcript must be fully caught up.
    const allowLag = op.kind === "adelta" || op.kind === "tdelta" || op.kind === "advance";
    if (!allowLag && lag.role) {
      failures.push(`${phase} I2 seq${seq}: non-delta event left pending ${lag.role}`);
    }
  };

  const finalCheck = (phase: string) => {
    // Final equality covers entries and persisted entries. The streamingIds
    // set is a transient UI flag: a stream whose first deltas coalesce into
    // one append never gets flagged (the flag is only added on successful
    // delta appends), so it may differ from the unbatched run without any
    // content/order/persistence change. Mid-run subset checks still enforce
    // that batching never adds a streaming id the reference lacks.
    const b = snapshotStore(p.batchedStore);
    const r = snapshotStore(p.refStore);
    const entriesEqual =
      b.entries.length === r.entries.length &&
      b.entries.every((e, i) => entryKey(e) === entryKey(r.entries[i]!));
    if (!entriesEqual) failures.push(`${phase} I1: final transcript diverged`);
    if (JSON.stringify(p.batchedPersist) !== JSON.stringify(p.refPersist)) {
      failures.push(`${phase} I1: persisted entries diverged`);
    }
    if (p.scheduler.pendingTimers !== 0) failures.push(`${phase} I4: ${p.scheduler.pendingTimers} timers after dispose`);
    const lag = consistentWithReference(b, r);
    if (!lag.ok || lag.role) failures.push(`${phase} I4: pending after dispose`);
  };

  ops.forEach((op, seq) => {
    if (st.disposed) return;
    if (op.kind === "dispose") {
      // I3 tail: after last event + batchMs nothing is pending.
      p.scheduler.advance(batchMs + 1);
      assertNoPending("I3");
      // Then feed one final delta and dispose immediately, so the dispose path
      // must flush real pending text (flush-on-dispose protection).
      finalDeltaAndDispose();
      return;
    }
    feedOp(p, op, seq, rand);
    check(op, seq, "");
  });

  if (!st.disposed) {
    p.scheduler.advance(batchMs + 1);
    assertNoPending("I3");
    finalDeltaAndDispose();
  }
  return failures;

  function assertNoPending(prefix: string): void {
    const b = snapshotStore(p.batchedStore);
    const r = snapshotStore(p.refStore);
    const lag = consistentWithReference(b, r);
    if (!lag.ok || lag.role) failures.push(`${prefix}: pending after last event + batchMs`);
    if (p.scheduler.pendingTimers > 0) failures.push(`${prefix}: timer armed after last event + batchMs`);
  }

  function finalDeltaAndDispose(): void {
    const t = textFor(rand);
    p.batched.onTextDelta(t);
    p.ref.onTextDelta(t);
    p.batched.dispose();
    p.ref.dispose();
    st.disposed = true;
    finalCheck("final");
  }
}

export function realBatched(mount: TranscriptMount, persist: (e: unknown) => void, scheduler: FakeScheduler): SinkLike {
  return new OpenTuiSink(mount, {} as unknown as ToastApi, {
    ambient: "inline",
    showThinking: () => true,
    onSpinnerMessage: () => {},
    ctxWindowTokens: 128_000,
    engineMode: false,
    projection: new TranscriptProjection({ useUnicode: false }),
    persistEntry: persist as (e: never) => void,
    streamBatchMs: BATCH_MS,
    batchScheduler: scheduler,
  });
}


// ---------------------------------------------------------------------------
// Removal checks: take out each protection one at a time, feed the same
// seeded generator to a deliberately naive batched sink, and show the
// invariant checker fails. This proves the seeded test can catch each
// protection's removal.
// ---------------------------------------------------------------------------

interface NaiveOpts {
  /** remove flush-before-non-delta-event */
  flushBeforeEvents: boolean;
  /** remove flush-on-stream-change (merges cross-stream text) */
  flushOnStreamChange: boolean;
  /** remove flush-on-dispose */
  flushOnDispose: boolean;
  /** remove timer clear on flush/dispose */
  clearTimerOnFlush: boolean;
  /** use trailing debounce instead of leading-edge arm */
  trailing: boolean;
}

class NaiveBatchedSink implements SinkLike {
  private pending: {
    kind: "assistant" | "thinking";
    id: string;
    group: number;
    text: string;
  } | null = null;
  private timer: { clear(): void } | null = null;
  private disposed = false;
  private assistantStreamId: string | null = null;
  private thinkingStreamId: string | null = null;
  private group = 1;
  private nextLocalId = 1;

  constructor(
    private opts: NaiveOpts,
    private mount: TranscriptMount,
    private projection: TranscriptProjection,
    private batchMs: number,
    private scheduler: FakeScheduler,
    private persist: (e: unknown) => void,
  ) {}

  appendUser(text: string): void {
    this.applyNonDelta({ type: "user_submitted", id: this.nextId("user"), group: this.group, text });
  }
  onTextDelta(delta: string): void {
    this.assistantStreamId ??= this.nextId("assistant");
    this.queueDelta("assistant", this.assistantStreamId, this.group, delta);
  }
  onThinkingDelta(delta: string): void {
    this.thinkingStreamId ??= this.nextId("thinking");
    this.queueDelta("thinking", this.thinkingStreamId, this.group, delta);
  }
  onToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    this.applyNonDelta({ type: "tool_call_started", id: toolCallId, group: this.group, toolName, args });
  }
  onToolResult(toolCallId: string, toolName: string, resultText: string, isError = false): void {
    this.applyNonDelta({ type: "tool_call_finished", id: toolCallId, group: this.group, toolName, resultText, isError });
  }
  onFallback(text: string): void {
    this.applyNonDelta({ type: "system_line", id: this.nextId("system"), group: this.group, text });
  }
  onError(entry: { level: string; domain: string; message: string }): void {
    if (entry.level !== "error" && entry.level !== "warn") return;
    if (entry.domain === "llm") return;
    this.applyNonDelta({ type: "system_line", id: this.nextId("system"), group: this.group, text: `[${entry.domain}] ${entry.message}` });
  }
  appendTurnFooter(durationMs: number): void {
    this.finalizeStreams();
    const text = formatTurnFooterDigest({
      durationMs,
      stats: undefined,
      ambient: "inline",
      editCount: 0,
      writeCount: 0,
      ctxBeforePct: 0,
      ctxAfterPct: 0,
      engineMode: false,
      distillerSavingsTurn: 0,
      model: undefined,
      repeatFileReads: undefined,
      churnInterventions: undefined,
    });
    this.applyNonDelta({ type: "turn_footer", id: this.nextId("footer"), group: this.group, text });
  }
  flushText(): void {
    this.flush();
  }
  nextGroup(): void {
    this.flush();
    this.group++;
    this.assistantStreamId = null;
    this.thinkingStreamId = null;
    this.projection.apply({ type: "turn_started", group: this.group });
  }
  onToolCallsStart(): void {
    this.finalizeStreams();
  }
  dispose(): void {
    if (this.disposed) return;
    if (this.opts.flushOnDispose) this.flush();
    this.disposed = true;
    if (this.timer && this.opts.clearTimerOnFlush) {
      this.timer.clear();
      this.timer = null;
    }
  }

  private finalizeStreams(): void {
    this.flush();
    this.projection.apply({ type: "streams_finalized", group: this.group });
    const entries = this.projection.entries();
    const assistant = entries.find((e) => e.id === this.assistantStreamId);
    const thinking = entries.find((e) => e.id === this.thinkingStreamId);
    if (assistant) this.persist(assistant);
    if (thinking) this.persist(thinking);
    this.mount.finalizeStreams?.([this.assistantStreamId, this.thinkingStreamId]);
    this.assistantStreamId = null;
    this.thinkingStreamId = null;
  }

  private queueDelta(kind: "assistant" | "thinking", id: string, group: number, delta: string): void {
    if (this.pending && this.pending.id === id) {
      this.pending.text += delta;
      if (this.opts.trailing) this.arm();
      return;
    }
    if (this.pending && this.pending.id !== id) {
      if (this.opts.flushOnStreamChange) {
        this.flush();
      } else {
        // merged into the wrong buffer (cross-stream text corruption)
        this.pending.text += delta;
        if (this.opts.trailing) this.arm();
        return;
      }
    }
    this.pending = { kind, id, group, text: delta };
    if (!this.opts.trailing) this.arm();
  }

  private arm(): void {
    if (this.timer && this.opts.trailing) this.timer.clear();
    const h = this.scheduler.schedule(() => {
      this.timer = null;
      this.flush();
    }, this.batchMs);
    this.timer = h;
  }

  private flush(): void {
    if (!this.pending || this.disposed) return;
    const p = this.pending;
    this.pending = null;
    if (this.timer && this.opts.clearTimerOnFlush) {
      this.timer.clear();
      this.timer = null;
    }
    this.applyDelta(p.kind, p.id, p.group, p.text);
  }

  private applyDelta(kind: "assistant" | "thinking", id: string, group: number, delta: string): void {
    const event = {
      type: kind === "assistant" ? "assistant_delta" : "thinking_delta",
      id,
      group,
      delta,
    } as const;
    const changed = this.projection.apply(event);
    if (kind === "assistant") {
      if (!this.mount.appendAssistantDelta(id, delta) && changed) this.mount.appendEntry(changed);
    } else if (!this.mount.appendThinkingDelta(id, delta) && changed) {
      this.mount.appendEntry(changed);
    }
  }

  private applyNonDelta(event: Parameters<TranscriptProjection["apply"]>[0]): void {
    if (this.opts.flushBeforeEvents) this.flush();
    const changed = this.projection.apply(event);
    if (event.type === "tool_call_finished") {
      if (!changed || changed.role !== "tool" || !this.mount.patchToolResult(changed.id, changed as ToolEntry)) {
        if (changed) this.mount.appendEntry(changed);
      }
    } else if (changed) {
      this.mount.appendEntry(changed);
    }
    if (changed) this.persist(changed);
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.group}-${this.nextLocalId++}`;
  }
}

export function naiveBatched(opts: NaiveOpts): (mount: TranscriptMount, persist: (e: unknown) => void, scheduler: FakeScheduler) => SinkLike {
  return (mount, persist, scheduler) =>
    new NaiveBatchedSink(opts, mount, new TranscriptProjection({ useUnicode: false }), BATCH_MS, scheduler, persist);
}

export const CORRECT: NaiveOpts = {
  flushBeforeEvents: true,
  flushOnStreamChange: true,
  flushOnDispose: true,
  clearTimerOnFlush: true,
  trailing: false,
};

export function removalFailureKinds(opts: NaiveOpts, seeds: number): Map<string, number> {
  const agg = new Map<string, number>();
  for (let seed = 0; seed < seeds; seed++) {
    const ops = generateOps(mulberry32(seed), 70);
    for (const f of runScenario(seed, BATCH_MS, ops, naiveBatched(opts))) {
      agg.set(f, (agg.get(f) ?? 0) + 1);
    }
  }
  return agg;
}

