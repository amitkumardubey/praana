import { expect, test } from "bun:test";
import { CanonicalTranscriptError, emitCanonicalTranscript, type CanonicalRecord } from "../src/canonical-transcript.js";
import type { ConversationMessage } from "../src/llm/types.js";
import { estimateTokens } from "../src/token-estimate.js";
import type { Event } from "../src/types.js";

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

test("message estimator includes every content-part payload and tool-result metadata", async () => {
  const { estimateMessageTokens } = await api();
  const base: ConversationMessage = { role: "user", content: [] };
  for (const part of [
    { type: "text" as const, text: "文字".repeat(100) },
    { type: "thinking" as const, thinking: "thinking".repeat(100), signature: "signed".repeat(100) },
    { type: "image" as const, mimeType: "image/png", data: "base64".repeat(300) },
  ]) expect(estimateMessageTokens({ role: "user", content: [part] })).toBeGreaterThan(estimateMessageTokens(base) + 100);
  const tool: ConversationMessage = { role: "tool_result", toolCallId: "call", toolName: "shell", result: "" };
  for (const message of [
    { ...tool, result: "result".repeat(200) }, { ...tool, toolName: "name".repeat(200) }, { ...tool, toolCallId: "id".repeat(400) },
  ]) expect(estimateMessageTokens(message)).toBeGreaterThan(estimateMessageTokens(tool) + 150);
  expect(estimateMessageTokens({ ...tool, isError: true })).toBeGreaterThan(estimateMessageTokens(tool));
  expect(estimateMessageTokens({ role: "system", content: "system".repeat(100) })).toBeGreaterThan(150);
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
