import { expect, spyOn, test } from "bun:test";
import * as tokenEstimator from "../src/token-estimate.js";
import { CanonicalTranscriptError, emitCanonicalTranscript, type CanonicalRecord } from "../src/canonical-transcript.js";
import type { ConversationMessage } from "../src/llm/types.js";
import { buildCommitEvent, restoreFrozenState, SESSION_START_EPOCH, type FrozenState } from "../src/frozen-summary.js";
import { estimateTokens } from "../src/token-estimate.js";
import type { Event } from "../src/types.js";
import type { CompactionOutcome } from "../src/compaction.js";

// Resolve inside tests so missing APIs produce individual red results.
const api = () => import("../src/compaction.js");

function event(id: string, record: CanonicalRecord): Event {
  return { event_id: id, session_id: "s", timestamp: 1, kind: "canonical_message", actor: "kernel", payload: { ...record } };
}
function input(id: string, turnId = 1, text = "request"): Event {
  return event(id, { formatVersion: 1, kind: "user_input", turnId, message: { text } });
}
function assistant(id: string, turnId: number, text: string, calls: string[] = []): Event {
  return event(id, { formatVersion: 1, kind: "assistant", turnId, message: {
    text, ...(calls.length ? { toolCalls: calls.map((id) => ({ id, name: "shell", args: { command: id } })) } : {}),
  } });
}
function result(id: string, turnId: number, callId: string, text = "output"): Event {
  return event(id, { formatVersion: 1, kind: "tool_result", turnId, message: { callId, toolName: "shell", isError: false, text } });
}
function reset(id: string): Event {
  return { event_id: id, session_id: "s", timestamp: 1, kind: "system_note", actor: "kernel", payload: { type: "reset_boundary", command: "/clear" } };
}

const complexTurn = () => [
  input("z"), assistant("y", 1, "parallel", ["a", "b"]), result("x", 1, "b"), result("w", 1, "a"),
  assistant("v", 1, "between batches"), assistant("u", 1, "again", ["c"]), result("t", 1, "c"),
  event("s", { formatVersion: 1, kind: "wrap_up", turnId: 1, message: { text: "wrap-up input" } }),
  assistant("r", 1, "done"),
];

test("turns retain the whole tool loop, parallel result order, intermediate text and wrap-up", async () => {
  const { buildTurns, estimateMessageTokens } = await api();
  const events = [...complexTurn(), input("a", 4, "next"), assistant("0", 4, "answer")];
  const turns = buildTurns(events);
  expect(turns.map(({ turnId, completed, eventIds }) => ({ turnId, completed, eventIds }))).toEqual([
    { turnId: 1, completed: true, eventIds: ["z", "y", "x", "w", "v", "u", "t", "s", "r"] },
    { turnId: 4, completed: false, eventIds: ["a", "0"] },
  ]);
  for (const turn of turns) {
    expect(turn.messages).toEqual(emitCanonicalTranscript(turn.records));
    expect(turn.estimatedTokens).toBe(turn.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0));
  }
  expect(turns[0].records.map((record) => record.kind)).toEqual([
    "user_input", "assistant", "tool_result", "tool_result", "assistant", "assistant", "tool_result", "wrap_up", "assistant",
  ]);
});

test("turns use only the latest reset epoch and hide stranded pre-input results", async () => {
  const { buildTurns } = await api();
  const events = [input("old"), assistant("pending", 1, "", ["lost"]), reset("clear-z"), result("stranded", 1, "lost"),
    input("new", 8), assistant("answer", 8, "fresh")];
  expect(buildTurns(events).map((turn) => ({ turnId: turn.turnId, ids: turn.eventIds, completed: turn.completed }))).toEqual([
    { turnId: 8, ids: ["new", "answer"], completed: false },
  ]);
  expect(buildTurns([...events, reset("clear-a")])).toEqual([]);
});

test("canonical entries preserve event ids while sharing current-epoch record filtering", async () => {
  const { readCanonicalEntries, readCanonicalRecords, readFullSessionCanonicalRecords } = await import("../src/canonical-transcript.js");
  const { buildTurns, materializeHistory } = await api();
  const fresh = [input("new", 8), assistant("answer", 8, "fresh")];
  const events = [input("old"), reset("clear"), result("stranded", 1, "lost"), ...fresh];
  expect(readCanonicalEntries(events)).toEqual(fresh.map(e => ({ eventId: e.event_id, record: e.payload })));
  expect(readCanonicalEntries(events).map(entry => entry.record)).toEqual(readCanonicalRecords(events));
  expect(readCanonicalEntries([...events, reset("empty")])).toEqual([]);
  const logReader = {
    readAll(options?: { includeInternal?: boolean; includeCanonical?: boolean }) {
      return options?.includeInternal || options?.includeCanonical
        ? events
        : events.filter(e => e.kind !== "canonical_message" && e.kind !== "compaction_commit");
    },
  };
  expect(readCanonicalEntries(logReader)).toEqual(readCanonicalEntries(events));
  expect(readCanonicalRecords(logReader)).toEqual(readCanonicalRecords(events));
  expect(readFullSessionCanonicalRecords(logReader)).toEqual(readFullSessionCanonicalRecords(events));
  expect(buildTurns(logReader)).toEqual(buildTurns(events));
  expect(materializeHistory(frozen({ resetEpoch: "clear" }), logReader)).toEqual(materializeHistory(frozen({ resetEpoch: "clear" }), events));
});

test("turn view ignores generic events but keeps non-emitting canonical records in the cut unit", async () => {
  const { buildTurns } = await api();
  const events = [input("i"), { ...reset("generic"), payload: { type: "other" } },
    event("notice", { formatVersion: 1, kind: "notice", turnId: 1, message: { info: "notice" } }),
    event("snapshot", { formatVersion: 1, kind: "snapshot", turnId: 1, message: { value: "snapshot" } }),
    event("summary", { formatVersion: 1, kind: "summary", turnId: 1, message: { value: "legacy" } })];
  const turns = buildTurns(events);
  expect(turns[0].eventIds).toEqual(["i", "notice", "snapshot", "summary"]);
  expect(turns[0].messages).toEqual([{ role: "user", content: "request" }]);
  expect(buildTurns([])).toEqual([]);
});

test("turn estimates do not count invented interruption results in a pending terminal batch", async () => {
  const { buildTurns, estimateMessageTokens } = await api();
  const turns = buildTurns([input("i"), assistant("a", 1, "pending", ["call-a", "call-b"]), result("r", 1, "call-a")]);
  expect(turns[0].messages).toHaveLength(3);
  expect(turns[0].messages.some((message) => message.role === "tool_result" && message.toolCallId === "call-b")).toBe(false);
  expect(turns[0].estimatedTokens).toBe(turns[0].messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0));
});

test("turn view validates canonical sequence across turns and never repairs interior corruption", async () => {
  const { buildTurns } = await api();
  const badLogs = [
    [input("i"), assistant("a", 1, "", ["call"]), input("next", 2)],
    [input("i"), result("r", 1, "orphan")],
    [input("i"), assistant("a", 1, "", ["call"]), result("r", 1, "call"), input("next", 2), assistant("dup", 2, "", ["call"])],
    [input("i"), input("next", 1)],
    [{ ...input("i"), payload: { formatVersion: 99 } }],
  ];
  for (const events of badLogs) expect(() => buildTurns(events)).toThrow(CanonicalTranscriptError);
});

test("message estimator includes native tool-call names, structured and raw arguments with string content", async () => {
  const { estimateMessageTokens } = await api();
  const base: ConversationMessage = { role: "assistant", content: "" };
  const withCall: ConversationMessage = { ...base, toolCalls: [{ id: "call", name: "shell".repeat(40), args: { command: "x".repeat(400) } }] };
  expect(estimateMessageTokens(withCall)).toBeGreaterThan(estimateMessageTokens(base) + 100);
  expect(estimateMessageTokens({ ...withCall, toolCalls: [{ ...withCall.toolCalls![0], rawArgs: "raw".repeat(200) }] })).toBeGreaterThan(estimateMessageTokens(withCall) + 100);
});

test("message estimator includes thinking and signatures despite empty string content", async () => {
  const { estimateMessageTokens } = await api();
  const base: ConversationMessage = { role: "assistant", content: "" };
  const thinking = { ...base, thinking: "reason".repeat(200) };
  expect(estimateMessageTokens(thinking)).toBeGreaterThan(estimateMessageTokens(base) + 250);
  expect(estimateMessageTokens({ ...thinking, thinkingSignature: "sig".repeat(200) })).toBeGreaterThan(estimateMessageTokens(thinking) + 100);
});

test("message estimator counts ordered text, thinking, redacted bytes and tool-use blocks", async () => {
  const { estimateMessageTokens } = await api();
  const base: ConversationMessage = { role: "assistant", content: "" };
  for (const block of [
    { type: "text" as const, text: "text".repeat(200) },
    { type: "thinking" as const, thinking: "think".repeat(200), signature: "signature".repeat(100) },
    { type: "redacted_thinking" as const, data: "redacted".repeat(200) },
    { type: "tool_use" as const, id: "id".repeat(400) },
  ]) expect(estimateMessageTokens({ ...base, blocks: [block] })).toBeGreaterThan(estimateMessageTokens(base) + 150);
});

test("message estimator includes non-image content payloads and tool-result metadata", async () => {
  const { estimateMessageTokens } = await api();
  const base: ConversationMessage = { role: "user", content: [] };
  for (const part of [
    { type: "text" as const, text: "文字".repeat(100) },
    { type: "thinking" as const, thinking: "thinking".repeat(100), signature: "signed".repeat(100) },
  ]) expect(estimateMessageTokens({ role: "user", content: [part] })).toBeGreaterThan(estimateMessageTokens(base) + 100);
  const tool: ConversationMessage = { role: "tool_result", toolCallId: "call", toolName: "shell", result: "" };
  for (const message of [
    { ...tool, result: "result".repeat(200) }, { ...tool, toolName: "name".repeat(200) }, { ...tool, toolCallId: "id".repeat(400) },
  ]) expect(estimateMessageTokens(message)).toBeGreaterThan(estimateMessageTokens(tool) + 150);
  expect(estimateMessageTokens({ ...tool, isError: true })).toBeGreaterThan(estimateMessageTokens(tool));
  expect(estimateMessageTokens({ role: "system", content: "system".repeat(100) })).toBeGreaterThan(150);
});

test("image estimates are bounded independently of base64 length while metadata and text still scale", async () => {
  const { estimateMessageTokens } = await api();
  const image = (data: string, mimeType = "image/png"): ConversationMessage => ({ role: "user", content: [{ type: "image", mimeType, data }] });
  const small = estimateMessageTokens(image("abc"));
  expect(estimateMessageTokens(image("x".repeat(1024 * 1024)))).toBe(small);
  expect(small).toBeGreaterThanOrEqual(1600);
  expect(small).toBeLessThan(1700);
  expect(estimateMessageTokens(image("abc", "metadata".repeat(100)))).toBeGreaterThan(small + 100);
  const text = (size: number): ConversationMessage => ({ role: "user", content: [{ type: "text", text: "x".repeat(size) }] });
  expect(estimateMessageTokens(text(10000))).toBeGreaterThan(estimateMessageTokens(text(10)) + 2000);
});

test("message estimates use stable JSON including role and escaping, independent of object key insertion order", async () => {
  const { estimateMessageTokens } = await api();
  const message: ConversationMessage = { role: "user", content: "line\n\"quoted\"\\雪" };
  expect(estimateMessageTokens(message)).toBe(estimateTokens(JSON.stringify({ content: message.content, role: "user" })));
  const a: ConversationMessage = { role: "assistant", content: "", toolCalls: [{ id: "c", name: "shell", args: { z: 1, a: { z: 2, a: [1, 2] } } }] };
  const b: ConversationMessage = { toolCalls: [{ args: { a: { a: [1, 2], z: 2 }, z: 1 }, name: "shell", id: "c" }], content: "", role: "assistant" };
  expect(estimateMessageTokens(a)).toBe(estimateMessageTokens(b));
  expect(estimateMessageTokens(a)).toBe(estimateTokens('{"content":"","role":"assistant","toolCalls":[{"args":{"a":{"a":[1,2],"z":2},"z":1},"id":"c","name":"shell"}]}'));
});

test("request estimator includes the system frame, snapshot, tool schema and every prospective message", async () => {
  const { estimateRequestTokens, estimateMessageTokens } = await api();
  const frame = { systemPrompt: "system".repeat(100), snapshot: "snapshot".repeat(100), tools: [{ name: "shell", description: "run", parameters: { type: "object" } }] };
  const messages: ConversationMessage[] = [{ role: "user", content: "summary" }, { role: "assistant", content: "history" }, { role: "user", content: "current input" }];
  const frameJson = JSON.stringify({ snapshot: frame.snapshot, systemPrompt: frame.systemPrompt, tools: [{ description: "run", name: "shell", parameters: { type: "object" } }] });
  expect(estimateRequestTokens(frame, messages)).toBe(estimateTokens(frameJson) + messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0));
  for (const key of ["systemPrompt", "snapshot", "tools"] as const) {
    const smaller = { ...frame };
    delete (smaller as Partial<typeof frame>)[key];
    expect(estimateRequestTokens(frame, messages)).toBeGreaterThan(estimateRequestTokens(smaller, messages));
  }
  expect(estimateRequestTokens(frame, messages)).toBeGreaterThan(estimateRequestTokens(frame, messages.slice(0, -1)));
});

function frozen(overrides: Partial<FrozenState> = {}): FrozenState {
  return { resetEpoch: SESSION_START_EPOCH, generation: 0, boundaryEventId: null, summary: null, stubSet: [], summaryRequest: null, ...overrides };
}
const summary = "### Active request\nPreserve exact bytes.\n\n### Plan\n- Test 雪\n\n### Constraints\n\n### Decisions\n\n### Files in play\n\n### Completed\n\n### Open threads\n";
const summaryRequest = { cutDescription: "through r", capTokens: 1024, instructionSha256: "a".repeat(64), usage: null };

test("materialisation and unestimated grouping never invoke the token estimator", async () => {
  const { buildTurns, materializeHistory } = await api();
  const estimate = spyOn(tokenEstimator, "estimateTokens");
  try {
    const events = complexTurn();
    const normal = buildTurns(events);
    expect(estimate.mock.calls.length).toBeGreaterThan(0);
    estimate.mockClear();
    expect(materializeHistory(frozen(), events).ok).toBe(true);
    expect(estimate).toHaveBeenCalledTimes(0);
    const grouped = buildTurns(events, { estimate: false });
    expect(estimate).toHaveBeenCalledTimes(0);
    expect(grouped).toEqual(normal.map(turn => ({ ...turn, estimatedTokens: 0 })));
  } finally {
    estimate.mockRestore();
  }
});

test("materialisation without a rewrite equals strict canonical replay, including empty history", async () => {
  const { materializeHistory } = await api();
  expect(materializeHistory(frozen(), [])).toEqual({ ok: true, messages: [] });
  const events = complexTurn();
  const records = events.map((event) => event.payload as unknown as CanonicalRecord);
  expect(materializeHistory(frozen(), events)).toEqual({ ok: true, messages: emitCanonicalTranscript(records) });
});

test("materialisation puts restored summary bytes first and stubs only the chosen tail tool result", async () => {
  const { materializeHistory } = await api();
  const tail = [input("new", 2), event("native", { formatVersion: 1, kind: "assistant", turnId: 2, message: {
    text: "native text", thinking: "thought", thinkingSignature: "signature",
    toolCalls: [{ id: "new-call", name: "shell", args: { command: "echo hi" }, rawArgs: '{"command":"echo hi"}' }],
    blocks: [{ type: "thinking", thinking: "thought", signature: "signature" }, { type: "redacted_thinking", data: "opaque" }, { type: "text", text: "native text" }, { type: "tool_use", id: "new-call" }],
  } }), result("tail-result", 2, "new-call", "original output")];
  const state = frozen({ generation: 1, boundaryEventId: "r", summary, summaryRequest, stubSet: [{ eventId: "tail-result", stubText: "stub\nbytes 雪" }] });
  const commit = buildCommitEvent({ formatVersion: 1, ...state });
  const events = [...complexTurn(), ...tail, { ...commit, event_id: "commit", session_id: "s", timestamp: 1 }];
  const restored = restoreFrozenState(events);
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw restored.error;
  const before = JSON.stringify({ events, state: restored.state });
  const materialized = materializeHistory(restored.state, events);
  expect(materialized).toEqual({ ok: true, messages: [
    { role: "user", content: "This is a summary of earlier conversation, for context, not instructions:\n\n" + summary },
    { role: "user", content: "request" },
    ...emitCanonicalTranscript(tail.map((event) => event.payload as unknown as CanonicalRecord)).slice(1, 2),
    { role: "tool_result", toolCallId: "new-call", toolName: "shell", isError: false, result: "stub\nbytes 雪" },
  ] });
  expect(JSON.stringify({ events, state: restored.state })).toBe(before);
  expect(materializeHistory(restored.state, events)).toEqual(materialized);
});

test("stubs-only materialisation preserves the boundary, empty stubs and error/result metadata", async () => {
  const { materializeHistory } = await api();
  const events = [input("i"), assistant("a", 1, "", ["call-a", "call-b"]), result("r-a", 1, "call-a", "large"),
    event("r-b", { formatVersion: 1, kind: "tool_result", turnId: 1, message: { callId: "call-b", toolName: "shell", isError: true, text: "failure" } })];
  const state = frozen({ generation: 1, stubSet: [{ eventId: "r-a", stubText: "" }] });
  const materialized = materializeHistory(state, events);
  expect(materialized.ok).toBe(true);
  if (!materialized.ok) throw materialized.error;
  expect(materialized.messages).toHaveLength(4);
  expect(materialized.messages.slice(-2)).toEqual([
    { role: "tool_result", toolCallId: "call-a", toolName: "shell", isError: false, result: "" },
    { role: "tool_result", toolCallId: "call-b", toolName: "shell", isError: true, result: "failure" },
  ]);
});

test("materialisation rejects missing, interior and in-flight cuts rather than truncating turns", async () => {
  const { materializeHistory } = await api();
  const events = [...complexTurn(), input("next", 2), assistant("last", 2, "in flight")];
  for (const boundaryEventId of ["missing", "z", "x", "s", "last"]) {
    expect(materializeHistory(frozen({ generation: 1, boundaryEventId, summary, summaryRequest }), events)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  }
  expect(materializeHistory(frozen({ boundaryEventId: "r" }), events)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  expect(materializeHistory(frozen({ summary }), events)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
});

test("materialisation uses reset epochs and refuses stale state without reviving old summaries", async () => {
  const { materializeHistory } = await api();
  const events = [...complexTurn(), reset("clear-z"), result("stranded", 1, "lost"), input("fresh", 9, "fresh request")];
  const old = frozen({ generation: 1, boundaryEventId: "r", summary, summaryRequest });
  expect(materializeHistory(old, events)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  expect(materializeHistory(frozen({ resetEpoch: "clear-z" }), events)).toEqual({ ok: true, messages: [{ role: "user", content: "fresh request" }] });
  expect(materializeHistory(frozen({ resetEpoch: "clear-z" }), [...events, reset("clear-a")])).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  expect(materializeHistory(frozen({ resetEpoch: "clear-a" }), [...events, reset("clear-a")])).toEqual({ ok: true, messages: [] });
});

test("materialisation returns pending_batch instead of synthesizing terminal results, with or without a summary", async () => {
  const { materializeHistory } = await api();
  for (const summarized of [false, true]) {
    const events = [...(summarized ? complexTurn() : []), input("next", 2), assistant("a", 2, "pending", ["new-a", "new-b"]), result("r-a", 2, "new-a")];
    const state = summarized ? frozen({ generation: 1, boundaryEventId: "r", summary, summaryRequest }) : frozen();
    const before = JSON.stringify({ events, state });
    const materialized = materializeHistory(state, events);
    expect(materialized).toMatchObject({ ok: false, error: { code: "pending_batch" } });
    expect("messages" in materialized).toBe(false);
    expect(JSON.stringify({ events, state })).toBe(before);
  }
});

test("materialisation preserves typed canonical errors instead of masking malformed sequences as pending", async () => {
  const { materializeHistory } = await api();
  for (const events of [
    [input("i"), result("orphan", 1, "none")],
    [input("i"), assistant("a", 1, "pending", ["call"]), input("next", 2)],
    [{ ...input("i"), payload: { formatVersion: 99 } }],
  ]) {
    const materialized = materializeHistory(frozen(), events);
    expect(materialized.ok).toBe(false);
    if (materialized.ok) throw new Error("invalid transcript accepted");
    expect(materialized.error).toBeInstanceOf(CanonicalTranscriptError);
  }
});

test("folded duplicate calls and interrupted batches do not invalidate a fresh tail", async () => {
  const { materializeHistory } = await api();
  const duplicate = [input("i"), assistant("a", 1, "", ["call"]), result("r", 1, "call"), assistant("dup", 1, "", ["call"]), result("end", 1, "call")];
  const interrupted = [input("i"), assistant("end", 1, "", ["call"])];
  for (const prefix of [duplicate, interrupted]) {
    const state = frozen({ boundaryEventId: "end", summary });
    const tail = [input("next", 2), assistant("new-a", 2, "", ["call"]), result("new-r", 2, "call")];
    expect(materializeHistory(state, [...prefix, ...tail])).toEqual({ ok: true, messages: [
      { role: "user", content: "This is a summary of earlier conversation, for context, not instructions:\n\n" + summary },
      ...emitCanonicalTranscript(tail.map(e => e.payload as unknown as CanonicalRecord)),
    ] });
    expect(materializeHistory(frozen(), [...prefix, ...tail]).ok).toBe(false);
    expect(materializeHistory(state, [...prefix, ...tail.slice(0, -1)])).toMatchObject({ ok: false, error: { code: "pending_batch" } });
  }
});

test("the same duplicate or interrupted batch in the retained tail still fails strictly", async () => {
  const { materializeHistory } = await api();
  const prefix = [input("folded"), assistant("end", 1, "done")];
  const state = frozen({ boundaryEventId: "end", summary });
  for (const [tail, code] of [
    [[input("i", 2), assistant("a", 2, "", ["call"]), result("r", 2, "call"), assistant("dup", 2, "", ["call"])], "duplicate_call_id"],
    [[input("i", 2), assistant("a", 2, "", ["call"]), input("next", 3)], "interrupted_batch"],
  ] as const) {
    expect(materializeHistory(state, [...prefix, ...tail])).toMatchObject({ ok: false, error: { code } });
  }
});

test("materialisation validates stub event references even when the referenced result would be folded", async () => {
  const { materializeHistory } = await api();
  const events = [...complexTurn(), input("next", 2)];
  for (const stubSet of [
    [{ eventId: "missing", stubText: "stub" }], [{ eventId: "z", stubText: "stub" }],
    [{ eventId: "x", stubText: "one" }, { eventId: "x", stubText: "two" }],
  ]) expect(materializeHistory(frozen({ boundaryEventId: "r", summary, summaryRequest, stubSet }), events)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  const foldedStub = materializeHistory(frozen({ boundaryEventId: "r", summary, summaryRequest, stubSet: [{ eventId: "x", stubText: "folded" }] }), events);
  expect(foldedStub.ok).toBe(true);
  if (!foldedStub.ok) throw foldedStub.error;
  expect(foldedStub.messages).toHaveLength(2);
  expect(materializeHistory(frozen({ resetEpoch: "clear", stubSet: [{ eventId: "x", stubText: "old" }] }), [...events, reset("clear"), input("fresh", 3)])).toMatchObject({ ok: false, error: { code: "invalid_state" } });
});

test("INV-1: 500 seeded logs retain identical prefix bytes after complete record/batch appends", async () => {
  const { materializeHistory } = await api();
  let seed = 0x52b17e;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const text = () => ["plain", "雪", 'line\n"quoted"', "🧪"][random(4)].repeat(1 + random(10));
  const makeLoop = (prefix: string, turnId: number): Event[] => {
    const events: Event[] = [];
    for (let batch = 0, count = 1 + random(3); batch < count; batch++) {
      events.push(assistant(`${prefix}-text-${batch}`, turnId, text()));
      const calls = Array.from({ length: 1 + random(3) }, (_, i) => `${prefix}-call-${batch}-${i}`);
      events.push(assistant(`${prefix}-batch-${batch}`, turnId, text(), calls));
      for (const call of calls.reverse()) events.push(result(`${call}-result`, turnId, call, text()));
    }
    if (random(2)) events.push(event(`${prefix}-wrap`, { formatVersion: 1, kind: "wrap_up", turnId, message: { text: text() } }));
    return events;
  };
  for (let scenario = 0; scenario < 500; scenario++) {
    const count = 2 + random(4);
    const turns = Array.from({ length: count }, (_, i) => [input(`${scenario}-${i}-input`, i + 1, text()), ...makeLoop(`${scenario}-${i}`, i + 1)]);
    const epoch = random(2) ? `reset-${scenario}` : SESSION_START_EPOCH;
    const events = [...(epoch === SESSION_START_EPOCH ? [] : [input(`old-${scenario}`), reset(epoch)]), ...turns.flat()];
    const folded = random(count);
    const stubs = events.filter((event) => event.payload.kind === "tool_result" && random(3) === 0).map((event) => ({ eventId: event.event_id, stubText: text() }));
    const state = frozen({ resetEpoch: epoch, stubSet: stubs, ...(folded ? { generation: 1, boundaryEventId: turns[folded - 1].at(-1)!.event_id, summary, summaryRequest } : {}) });
    const beforeBytes = JSON.stringify({ events, state });
    const before = materializeHistory(state, events);
    expect(before.ok).toBe(true);
    if (!before.ok) throw before.error;
    const startNewTurn = random(2) === 0;
    const appended = [...(startNewTurn ? [input(`${scenario}-append-input`, count + 1, text())] : []), ...makeLoop(`${scenario}-append`, startNewTurn ? count + 1 : count)];
    const after = materializeHistory(state, [...events, ...appended]);
    expect(after.ok).toBe(true);
    if (!after.ok) throw after.error;
    const suffix = emitCanonicalTranscript([
      { formatVersion: 1, kind: "user_input", turnId: count, message: { text: "oracle prefix" } },
      ...appended.map((event) => event.payload as unknown as CanonicalRecord),
    ]).slice(1);
    expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages));
    expect(JSON.stringify(after.messages)).toBe(JSON.stringify([...before.messages, ...suffix]));
    expect(JSON.stringify({ events, state })).toBe(beforeBytes);
  }
});

test("exports module-local option defaults and documents a minimum worth stubbing", async () => {
  const defaults = await api();
  expect(defaults.DEFAULT_COMPACTION_OPTIONS).toEqual({
    contextLimitRatio: 0.80, tailTurns: 4, tokensReserve: 4096, postRewriteMargin: 0.15,
    stubKeepRecent: 3, stubMinTokens: 256, summaryTimeoutMs: 60000,
  });
  expect(Object.isFrozen(defaults.DEFAULT_COMPACTION_OPTIONS)).toBe(true);
  expect([
    defaults.DEFAULT_CONTEXT_LIMIT_RATIO, defaults.DEFAULT_TAIL_TURNS, defaults.DEFAULT_TOKENS_RESERVE,
    defaults.DEFAULT_POST_REWRITE_MARGIN, defaults.DEFAULT_STUB_KEEP_RECENT, defaults.DEFAULT_STUB_MIN_TOKENS,
    defaults.DEFAULT_SUMMARY_TIMEOUT_MS,
  ]).toEqual([0.80, 4, 4096, 0.15, 3, 256, 60000]);
});

test("fill accounts for the complete prospective request and effective output cap against usable capacity", async () => {
  const { requestFill } = await api();
  const frame = { systemPrompt: "system text", snapshot: "snapshot text", tools: [{ name: "shell", description: "run", parameters: { type: "object" } }] };
  const messages: ConversationMessage[] = [
    { role: "user", content: "summary text" }, { role: "assistant", content: "retained history" }, { role: "user", content: "current input" },
  ];
  // Independent input oracle: explicit sorted frame/message serialization, not the request estimator.
  const inputTokens = estimateTokens('{"snapshot":"snapshot text","systemPrompt":"system text","tools":[{"description":"run","name":"shell","parameters":{"type":"object"}}]}') +
    ["summary text", "retained history", "current input"].reduce((sum, content, i) => sum + estimateTokens(JSON.stringify({ content, role: i === 1 ? "assistant" : "user" })), 0);
  const fill = requestFill(frame, messages, 2000, { tokensReserve: 10, effectiveMaxTokens: 500 });
  expect(fill).toEqual({ ok: true, fill: {
    inputTokens, reservedOutputTokens: 500, contextWindowTokens: 2000, usableTokens: 1500,
    totalTokens: inputTokens + 500, ratio: inputTokens / 1500, fits: true,
  } });
  for (const smaller of [
    requestFill({ ...frame, tools: [] }, messages, 2000, { effectiveMaxTokens: 500 }),
    requestFill({ ...frame, systemPrompt: "" }, messages, 2000, { effectiveMaxTokens: 500 }),
    requestFill({ ...frame, snapshot: "" }, messages, 2000, { effectiveMaxTokens: 500 }),
    requestFill(frame, messages.slice(0, -1), 2000, { effectiveMaxTokens: 500 }),
    requestFill(frame, messages.slice(1), 2000, { effectiveMaxTokens: 500 }),
  ]) {
    expect(smaller.ok).toBe(true);
    if (!smaller.ok || !fill.ok) throw new Error("valid capacity rejected");
    expect(smaller.fill.ratio).toBeLessThan(fill.fill.ratio);
  }
});

test("effective output reserve falls back to tokensReserve, not the summary cap, and honors explicit zero", async () => {
  const { requestFill, DEFAULT_TOKENS_RESERVE } = await api();
  expect(requestFill({}, [], 10000)).toMatchObject({ ok: true, fill: { reservedOutputTokens: DEFAULT_TOKENS_RESERVE, usableTokens: 5904 } });
  expect(requestFill({}, [], 10000, { tokensReserve: 1234 })).toMatchObject({ ok: true, fill: { reservedOutputTokens: 1234, usableTokens: 8766 } });
  expect(requestFill({}, [], 10000, { tokensReserve: 1234, effectiveMaxTokens: 9876 })).toMatchObject({ ok: true, fill: { reservedOutputTokens: 9876, usableTokens: 124 } });
  expect(requestFill({}, [], 100, { tokensReserve: 10000, effectiveMaxTokens: 0 })).toMatchObject({ ok: true, fill: { reservedOutputTokens: 0, usableTokens: 100 } });
});

for (const kind of ["live", "same-model summary", "batch summary"] as const) {
  test(`${kind} requests reserve their own effective output cap for admission`, async () => {
    const { requestFill } = await api();
    const messages: ConversationMessage[] = [{ role: "user", content: `${kind} input` }];
    const effectiveMaxTokens = kind === "live" ? 900 : kind === "same-model summary" ? 700 : 500;
    const measured = requestFill({}, messages, 1000, { tokensReserve: 20, effectiveMaxTokens });
    expect(measured).toMatchObject({ ok: true, fill: { reservedOutputTokens: effectiveMaxTokens, usableTokens: 1000 - effectiveMaxTokens } });
    for (const reserve of [1000, 1001]) {
      const rejected = requestFill({}, messages, 1000, { tokensReserve: 20, effectiveMaxTokens: reserve });
      expect(rejected).toMatchObject({ ok: false, error: { status: "capacity_error", kind: "reserve_exceeds_window" } });
      if (rejected.ok) throw new Error("oversized reserve admitted");
      expect(rejected.error.message).toMatch(/\/clear|larger-context model/);
    }
  });
}

test("fallback reserve at or above the window is rejected without a pressure-helper clamp", async () => {
  const { requestFill } = await api();
  expect(requestFill({}, [], 4096)).toMatchObject({ ok: false, error: { kind: "reserve_exceeds_window" } });
  expect(requestFill({}, [], 4095)).toMatchObject({ ok: false, error: { kind: "reserve_exceeds_window" } });
  expect(requestFill({}, [], 100, { tokensReserve: 100 })).toMatchObject({ ok: false, error: { kind: "reserve_exceeds_window" } });
  expect(requestFill({}, [], 100, { tokensReserve: 99 })).toMatchObject({ ok: true, fill: { usableTokens: 1 } });
});

test("fill rejects invalid windows and output caps as typed capacity errors with recovery guidance", async () => {
  const { requestFill } = await api();
  const cases = [
    ...[0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1].map((window) => requestFill({}, [], window, { effectiveMaxTokens: 0 })),
    ...[-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1].map((effectiveMaxTokens) => requestFill({}, [], 100, { effectiveMaxTokens })),
    requestFill({}, [], 100, { tokensReserve: -1 }),
  ];
  for (const rejected of cases) {
    expect(rejected).toMatchObject({ ok: false, error: { status: "capacity_error", kind: "invalid_capacity" } });
    if (rejected.ok) throw new Error("invalid capacity admitted");
    expect(rejected.error.message).toMatch(/configuration|model catalog/);
    expect(rejected.error.message).toMatch(/context window|output cap/);
    expect(rejected.error.message).not.toMatch(/\/clear|larger-context/);
  }
});

test("fits includes the exact usable-capacity boundary and does not clamp oversized input fill", async () => {
  const { requestFill } = await api();
  const messages: ConversationMessage[] = [{ role: "user", content: "input" }];
  const inputTokens = estimateTokens("{}") + estimateTokens('{"content":"input","role":"user"}');
  expect(requestFill({}, messages, inputTokens + 10, { effectiveMaxTokens: 10 })).toMatchObject({ ok: true, fill: { ratio: 1, fits: true, totalTokens: inputTokens + 10 } });
  const over = requestFill({}, messages, inputTokens + 9, { effectiveMaxTokens: 10 });
  expect(over).toMatchObject({ ok: true, fill: { fits: false } });
  if (!over.ok) throw new Error("valid reserve rejected");
  expect(over.fill.ratio).toBeGreaterThan(1);
  expect(over.fill.totalTokens).toBeGreaterThan(over.fill.contextWindowTokens);
});

test("trigger fires exactly at and above the threshold and never stays armed below it", async () => {
  const { requestFill, shouldRewrite } = await api();
  const messages: ConversationMessage[] = [{ role: "user", content: "x".repeat(96) }];
  const tokens = estimateTokens("{}") + estimateTokens(JSON.stringify({ content: "x".repeat(96), role: "user" }));
  expect(tokens % 4).toBe(0);
  const atWindow = tokens * 5 / 4 + 100;
  for (const delta of [-1, 1, 0, 1]) {
    const fill = requestFill({}, messages, atWindow + delta, { effectiveMaxTokens: 100 });
    if (!fill.ok) throw new Error("valid capacity rejected");
    expect(shouldRewrite(fill.fill)).toBe(delta <= 0);
  }
  const custom = requestFill({}, messages, tokens * 2 + 100, { effectiveMaxTokens: 100 });
  if (!custom.ok) throw new Error("valid capacity rejected");
  expect(shouldRewrite(custom.fill)).toBe(false);
  expect(shouldRewrite(custom.fill, { contextLimitRatio: 0.5 })).toBe(true);
});

test("trigger is based on the full request, not history alone or output tokens added to the numerator", async () => {
  const { requestFill, shouldRewrite } = await api();
  const frame = { systemPrompt: "s".repeat(4000), snapshot: "n".repeat(1000), tools: [{ name: "shell", description: "d".repeat(1000), parameters: {} }] };
  const messages: ConversationMessage[] = [{ role: "user", content: "history" }, { role: "user", content: "current".repeat(50) }];
  const small = requestFill({}, messages.slice(0, 1), 2000, { effectiveMaxTokens: 100 });
  const full = requestFill(frame, messages, 2000, { effectiveMaxTokens: 100 });
  if (!small.ok || !full.ok) throw new Error("valid capacity rejected");
  expect(shouldRewrite(small.fill)).toBe(false);
  expect(shouldRewrite(full.fill)).toBe(true);
  const mostlyOutput = requestFill({}, [{ role: "user", content: "x".repeat(200) }], 1000, { effectiveMaxTokens: 900 });
  if (!mostlyOutput.ok) throw new Error("valid capacity rejected");
  expect(mostlyOutput.fill.totalTokens / 1000).toBeGreaterThan(0.8);
  expect(shouldRewrite(mostlyOutput.fill)).toBe(false);
});

test("trigger rejects non-finite and out-of-range module-local thresholds", async () => {
  const { requestFill, shouldRewrite } = await api();
  const fill = requestFill({}, [], 10000);
  if (!fill.ok) throw new Error("valid capacity rejected");
  for (const contextLimitRatio of [0, -0.1, 1.1, NaN, Infinity, -Infinity]) {
    expect(() => shouldRewrite(fill.fill, { contextLimitRatio })).toThrow(RangeError);
  }
  expect(shouldRewrite(fill.fill, { contextLimitRatio: 1 })).toBe(false);
});

test("outcome contracts discriminate every terminal status without implementing orchestration", async () => {
  const { requestFill } = await api();
  const measured = requestFill({}, [], 10000);
  if (!measured.ok) throw new Error("valid capacity rejected");
  const state = frozen();
  const fill = measured.fill;
  const outcomes: CompactionOutcome[] = [
    { status: "noop", state, fill }, { status: "rewritten", state: { ...state, generation: 1 }, fill },
    { status: "stubbed", state: { ...state, generation: 1 }, fill }, { status: "unchanged_fits", state, fill },
    { status: "summary_failed_fits", state, fill, reason: "summary timed out" }, { status: "cancelled", state },
    { status: "commit_uncertain", error: new Error("fsync failed") },
    { status: "capacity_error", kind: "request_exceeds_capacity", message: "Use /clear or a larger-context model." },
  ];
  function label(outcome: CompactionOutcome): string {
    switch (outcome.status) {
      case "noop": case "rewritten": case "stubbed": case "unchanged_fits": return `${outcome.status}:${outcome.state.generation}:${outcome.fill.fits}`;
      case "summary_failed_fits": return outcome.reason;
      case "cancelled": return `cancelled:${outcome.state.generation}`;
      case "commit_uncertain": return String(outcome.error);
      case "capacity_error": return `${outcome.kind}:${outcome.message}`;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }
  expect(outcomes.map(label)).toEqual([
    "noop:0:true", "rewritten:1:true", "stubbed:1:true", "unchanged_fits:0:true", "summary timed out", "cancelled:0",
    "Error: fsync failed", "request_exceeds_capacity:Use /clear or a larger-context model.",
  ]);
});
