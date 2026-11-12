import { describe, expect, test } from "bun:test";
import {
  CANONICAL_TRANSCRIPT_VERSION,
  INTERRUPTED_TOOL_RESULT,
  CanonicalTranscriptError,
  emitCanonicalTranscript,
  nextCanonicalTurnId,
  readCanonicalRecords,
  repairCanonicalTranscript,
  type CanonicalRecord,
  type CanonicalAssistantRecord,
  type CanonicalToolCall,
  type CanonicalToolResultRecord,
  type CanonicalTranscriptErrorCode,
} from "../src/canonical-transcript.js";
import * as canonicalApi from "../src/canonical-transcript.js";
import type { ConversationMessage } from "../src/llm/types.js";
import type { Event } from "../src/types.js";

const user = (text = "hello", turnId = 1): CanonicalRecord => ({
  formatVersion: 1, kind: "user_input", turnId, message: { text },
});
const call = (id: string): CanonicalToolCall => ({ id, name: `tool_${id}`, args: { path: `${id}.ts` } });
const assistant = (toolCalls: CanonicalToolCall[] = [], text = "", turnId = 1): CanonicalAssistantRecord => ({
  formatVersion: 1, kind: "assistant", turnId, message: { text, toolCalls },
});
const result = (id: string, text = `result ${id}`, turnId = 1, isError = false): CanonicalToolResultRecord => ({
  formatVersion: 1, kind: "tool_result", turnId,
  message: { callId: id, toolName: `tool_${id}`, isError, text },
});
const event = (kind: Event["kind"], payload: object): Event => ({
  event_id: "fixed", session_id: "session", timestamp: 123,
  kind, actor: "kernel", payload: payload as Record<string, unknown>,
});
const canonical = (record: CanonicalRecord): Event => event("canonical_message", record);
// Deliberately bypass the static JSON contract to exercise runtime validation.
const invalidArgument = (bad: unknown): CanonicalAssistantRecord => assistant([
  { ...call("a"), args: { bad } as CanonicalToolCall["args"] },
]);

function rejects(records: CanonicalRecord[], code: CanonicalTranscriptErrorCode, index: number): void {
  try {
    emitCanonicalTranscript(records);
    throw new Error("Expected strict validation to reject the log");
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalTranscriptError);
    expect((error as CanonicalTranscriptError).code).toBe(code);
    expect((error as CanonicalTranscriptError).recordIndex).toBe(index);
  }
}

test("incremental validation agrees with full replay for seeded sequences", () => {
  const Validator = (canonicalApi as any).CanonicalValidator;
  expect(Validator).toBeDefined();
  let seed = 0x51234567;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return (e as CanonicalTranscriptError).code; } };
  for (let sequence = 0; sequence < 500; sequence++) {
    const validator = new Validator();
    const accepted: CanonicalRecord[] = [];
    for (let i = 0; i < 30; i++) {
      const id = String(random(6));
      const turn = 1 + random(5);
      const candidate = [user("x", turn), assistant([call(id)], "", turn), result(id, "ok", turn), assistant([], "x", turn), { ...result(id, "x", turn), message: { ...result(id).message, toolName: "wrong" } }, { ...user(), formatVersion: 2 }][random(6)] as CanonicalRecord;
      const expected = code(() => emitCanonicalTranscript([...accepted, candidate]));
      const actual = code(() => validator.accept(candidate));
      expect(actual).toBe(expected);
      if (actual === null) accepted.push(candidate);
    }
  }
});

test("writer validates each appended record only once", async () => {
  const Validator = (canonicalApi as any).CanonicalValidator;
  expect(Validator).toBeDefined();
  let validations = 0;
  const original = Validator.prototype.accept;
  Validator.prototype.accept = function (...args: unknown[]) { validations++; return original.apply(this, args); };
  try {
    const seeded = [user("previous"), ...Array.from({ length: 49 }, () => assistant())];
    const log = { readAll: () => seeded.map(canonical), append: () => {} } as any;
    const writer = new canonicalApi.CanonicalWriter(log, (error) => { throw error; });
    const turn = await writer.startTurn("start");
    for (let i = 0; i < 100; i++) await writer.assistant(turn, { role: "assistant", content: "ok" });
    expect(validations).toBe(151);
  } finally { Validator.prototype.accept = original; }
});

describe("canonical transcript", () => {
  test("full-session reader allocates across reset epochs and validates old records", () => {
    expect(canonicalApi).toHaveProperty("readFullSessionCanonicalRecords");
    const read = (canonicalApi as unknown as { readFullSessionCanonicalRecords: (events: Event[]) => CanonicalRecord[] }).readFullSessionCanonicalRecords;
    const events = [canonical(user("one")), event("system_note", { type: "reset_boundary" }), canonical(user("two", 2))];
    expect(nextCanonicalTurnId(read(events))).toBe(3);
    expect(readCanonicalRecords(events)).toEqual([user("two", 2)]);
    expect(() => read([event("canonical_message", { formatVersion: 999 }), ...events])).toThrow(CanonicalTranscriptError);
  });

  test("epoch reader drops only leading results whose calls precede reset", () => {
    const events = [canonical(user()), canonical(assistant([call("a")])), event("system_note", { type: "reset_boundary" }), canonical(result("a")), canonical(user("next", 2)), canonical(assistant([], "done", 2))];
    expect(readCanonicalRecords(events)).toEqual([user("next", 2), assistant([], "done", 2)]);
    expect(emitCanonicalTranscript(readCanonicalRecords(events))).toHaveLength(2);
    expect(() => emitCanonicalTranscript(readCanonicalRecords([...events, canonical(result("a", "late", 2))]))).toThrow(CanonicalTranscriptError);
  });

  test("deep JSON fails with invalid_record rather than overflowing the stack", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 10000; depth++) nested = { nested };
    rejects([user(), invalidArgument(nested)], "invalid_record", 1);
  });
  test("replays handwritten logical history as exact driver-contract literals without sanitizing", () => {
    const records: CanonicalRecord[] = [
      user("inspect"),
      {
        formatVersion: 1, kind: "assistant", turnId: 1,
        message: {
          text: "Before. After.", thinking: "onetwo", thinkingSignature: "sig-1sig-2",
          blocks: [
            { type: "thinking", thinking: "one", signature: "sig-1" },
            { type: "text", text: "Before." },
            { type: "redacted_thinking", data: "opaque==" },
            { type: "thinking", thinking: "two", signature: "sig-2" },
            { type: "tool_use", id: "read" },
            { type: "text", text: " After." },
          ],
          toolCalls: [{ id: "read", name: "read_file", args: { key: "[REDACTED:aws-access-key]", nested: [null, true, 2] }, rawArgs: '{ "key": "[REDACTED:aws-access-key]", "nested": [null,true,2] }' }],
        },
      },
      { formatVersion: 1, kind: "tool_result", turnId: 1, message: { callId: "read", toolName: "read_file", isError: true, text: "  [REDACTED:aws-access-key]\n\u0000\r\n" } },
      { formatVersion: 1, kind: "wrap_up", turnId: 1, message: { text: "Finish now." } },
      { formatVersion: 1, kind: "assistant", turnId: 1, message: { text: "Done." } },
    ];
    const expected: ConversationMessage[] = [
      { role: "user", content: "inspect" },
      {
        role: "assistant", content: "Before. After.", thinking: "onetwo", thinkingSignature: "sig-1sig-2",
        blocks: [
          { type: "thinking", thinking: "one", signature: "sig-1" },
          { type: "text", text: "Before." },
          { type: "redacted_thinking", data: "opaque==" },
          { type: "thinking", thinking: "two", signature: "sig-2" },
          { type: "tool_use", id: "read" },
          { type: "text", text: " After." },
        ],
        toolCalls: [{ id: "read", name: "read_file", args: { key: "[REDACTED:aws-access-key]", nested: [null, true, 2] }, rawArgs: '{ "key": "[REDACTED:aws-access-key]", "nested": [null,true,2] }' }],
      },
      { role: "tool_result", toolCallId: "read", toolName: "read_file", isError: true, result: "  [REDACTED:aws-access-key]\n\u0000\r\n" },
      { role: "user", content: "Finish now." },
      { role: "assistant", content: "Done." },
    ];
    const before = JSON.stringify(records);
    expect(CANONICAL_TRANSCRIPT_VERSION).toBe(1);
    expect(emitCanonicalTranscript(records)).toEqual(expected);
    expect(JSON.stringify(emitCanonicalTranscript(records))).toBe(JSON.stringify(expected));
    expect(JSON.stringify(records)).toBe(before);
    // Arguments are already sanitized by the caller; the pure emitter never rewrites them.
    expect(emitCanonicalTranscript([user(), assistant([{ id: "literal", name: "echo", args: { token: "unchanged" }, rawArgs: '{"token":"unchanged"}' }])])[1]).toMatchObject({ toolCalls: [{ args: { token: "unchanged" }, rawArgs: '{"token":"unchanged"}' }] });
  });

  test("pairs parallel calls by id and preserves batch boundaries and recorded result order", () => {
    const messages = emitCanonicalTranscript([
      user(), assistant([call("a"), call("b")], "batch one"), result("b", "B", 1, true), result("a", "A"),
      assistant([call("c")], "batch two"), result("c", "C"), assistant([], "finished"),
    ]);
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "batch one", toolCalls: [call("a"), call("b")] },
      { role: "tool_result", toolCallId: "b", toolName: "tool_b", result: "B", isError: true },
      { role: "tool_result", toolCallId: "a", toolName: "tool_a", result: "A", isError: false },
      { role: "assistant", content: "batch two", toolCalls: [call("c")] },
      { role: "tool_result", toolCallId: "c", toolName: "tool_c", result: "C", isError: false },
      { role: "assistant", content: "finished", toolCalls: [] },
    ]);
  });

  test("retains text-only steps before and between batches without merging messages", () => {
    expect(emitCanonicalTranscript([
      user(), assistant([], "before"), assistant([call("a")], "first"), result("a"),
      assistant([], "between"), assistant([call("b")], "second"), result("b"), assistant([], "after"),
    ]).map((message) => message.role === "tool_result" ? message.result : message.content)).toEqual([
      "hello", "before", "first", "result a", "between", "second", "result b", "after",
    ]);
  });

  test("reserved kinds are JSON-only but have no conversation projection", () => {
    const reserved: CanonicalRecord[] = ["notice", "snapshot", "summary"].map((kind) => ({
      formatVersion: 1, kind: kind as "notice" | "snapshot" | "summary", turnId: 1, message: { text: "not a message", nested: [null, 3] },
    }));
    expect(emitCanonicalTranscript([user(), ...reserved])).toEqual([{ role: "user", content: "hello" }]);
    expect(nextCanonicalTurnId([user(), ...reserved])).toBe(2);
  });

  test("allocates monotonic turn ids from user_input only, including resumed full-session lists", () => {
    const records: CanonicalRecord[] = [user("one"), assistant([], "reply"), { formatVersion: 1, kind: "wrap_up", turnId: 1, message: { text: "finish" } }];
    expect(nextCanonicalTurnId([])).toBe(1);
    expect(nextCanonicalTurnId(records)).toBe(2);
    records.push(user("two", nextCanonicalTurnId(records)), assistant([call("pending")], "", 2));
    expect(nextCanonicalTurnId(JSON.parse(JSON.stringify(records)))).toBe(3);
    expect(nextCanonicalTurnId([user("epoch", 12)])).toBe(13);
  });

  test("reader selects only canonical records in the last reset epoch without mutating events", () => {
    const newest = user("new", 3);
    const events = [
      // Malformed old records must not poison the visible epoch.
      event("canonical_message", { formatVersion: 999 }),
      canonical(user("old")), event("system_note", { type: "reset_boundary" }),
      canonical(user("middle", 2)), event("system_note", { type: "reset_boundary" }),
      event("agent_message", { type: "reset_boundary", text: "not a boundary" }), canonical(newest),
    ];
    const before = JSON.stringify(events);
    expect(readCanonicalRecords(events)).toEqual([newest]);
    expect(readCanonicalRecords([canonical(user())])).toEqual([user()]);
    expect(readCanonicalRecords([...events, event("system_note", { type: "reset_boundary" })])).toEqual([]);
    expect(JSON.stringify(events)).toBe(before);
    // Allocate from the whole session, not the current epoch alone.
    expect(nextCanonicalTurnId([user("one"), user("two", 2), newest])).toBe(4);
  });

  test("user_message and agent_message events never enter the emitted conversation", () => {
    const events = [
      event("user_message", { text: "audit user" }), canonical(user("canonical user")),
      event("tool_call", { id: "audit" }), event("tool_result", { text: "audit result" }),
      event("agent_message", { text: "audit agent" }), event("ui_transcript", { text: "UI" }), canonical(assistant([], "canonical reply")),
    ];
    expect(emitCanonicalTranscript(readCanonicalRecords(events))).toEqual([
      { role: "user", content: "canonical user" }, { role: "assistant", content: "canonical reply", toolCalls: [] },
    ]);
  });

  test("synthesizes only trailing pending calls in call order with a shared frozen result", async () => {
    const records = [user(), assistant([call("a"), call("b"), call("c")]), result("b")];
    const before = JSON.stringify(records);
    const expected: ConversationMessage[] = [
      { role: "tool_result", toolCallId: "a", toolName: "tool_a", result: "Tool execution was interrupted before a result was recorded.", isError: true },
      { role: "tool_result", toolCallId: "c", toolName: "tool_c", result: "Tool execution was interrupted before a result was recorded.", isError: true },
    ];
    expect(INTERRUPTED_TOOL_RESULT).toEqual({ text: "Tool execution was interrupted before a result was recorded.", isError: true });
    expect(Object.isFrozen(INTERRUPTED_TOOL_RESULT)).toBe(true);
    const emitted = JSON.stringify(emitCanonicalTranscript(records));
    expect(emitCanonicalTranscript(records).slice(-2)).toEqual(expected);
    expect(JSON.stringify(emitCanonicalTranscript(records))).toBe(emitted);
    expect(JSON.stringify(records)).toBe(before);
    const appended: CanonicalToolResultRecord[] = [];
    expect(await repairCanonicalTranscript(records, (record) => { appended.push(record); })).toBe(2);
    expect(JSON.stringify(records)).toBe(before);
    expect(appended).toEqual([
      result("a", "Tool execution was interrupted before a result was recorded.", 1, true),
      result("c", "Tool execution was interrupted before a result was recorded.", 1, true),
    ]);
    records.push(...appended);
    expect(JSON.stringify(emitCanonicalTranscript(records))).toBe(emitted);
    expect(await repairCanonicalTranscript(records, () => { throw new Error("duplicate append"); })).toBe(0);
  });

  test("repair survives a callback failure after a partial durable append and retains batch turn ids", async () => {
    const records = [user("resumed", 9), assistant([call("a"), call("b"), call("c")], "", 9)];
    const before = JSON.stringify(emitCanonicalTranscript(records));
    const crash = new Error("crash after durable append");
    await expect(repairCanonicalTranscript(records, async (record) => {
      records.push(record);
      throw crash;
    })).rejects.toBe(crash);
    expect(records).toHaveLength(3);
    expect(await repairCanonicalTranscript(records, async (record) => { records.push(record); })).toBe(2);
    expect(records.slice(2).map((record) => record.turnId)).toEqual([9, 9, 9]);
    expect(JSON.stringify(emitCanonicalTranscript(records))).toBe(before);
    expect(await repairCanonicalTranscript(records, () => { throw new Error("duplicate"); })).toBe(0);
  });

  test("repair validates the whole list before appending anything", async () => {
    const records = [user(), assistant([call("a")]), user("too early", 2)];
    let appends = 0;
    await expect(repairCanonicalTranscript(records, () => { appends++; })).rejects.toBeInstanceOf(CanonicalTranscriptError);
    expect(appends).toBe(0);
  });

  test.each([
    ["orphan result", [user(), result("missing")], "orphan_result", 1],
    ["orphan while another batch is pending", [user(), assistant([call("a")]), result("missing")], "orphan_result", 2],
    ["duplicate result", [user(), assistant([call("a")]), result("a"), result("a")], "duplicate_result", 3],
    ["duplicate result in partial batch", [user(), assistant([call("a"), call("b")]), result("a"), result("a")], "duplicate_result", 3],
    ["duplicate call in one batch", [user(), assistant([call("a"), call("a")])], "duplicate_call_id", 1],
    ["duplicate call across turns", [user(), assistant([call("a")]), result("a"), user("next", 2), assistant([call("a")], "", 2)], "duplicate_call_id", 4],
    ["result separated from batch", [user(), assistant([call("a")]), assistant([], "separator"), result("a")], "interrupted_batch", 2],
    ["new user interrupts batch", [user(), assistant([call("a")]), user("next", 2)], "interrupted_batch", 2],
    ["wrap-up interrupts batch", [user(), assistant([call("a")]), { formatVersion: 1, kind: "wrap_up", turnId: 1, message: { text: "finish" } }], "interrupted_batch", 2],
    ["reserved record interrupts batch", [user(), assistant([call("a")]), { formatVersion: 1, kind: "notice", turnId: 1, message: {} }], "interrupted_batch", 2],
    ["wrong tool name", [user(), assistant([call("a")]), { ...result("a"), message: { ...result("a").message, toolName: "other" } }], "tool_name_mismatch", 2],
    ["wrong result turn", [user(), assistant([call("a")]), result("a", "ok", 2)], "invalid_turn", 2],
    ["nonmonotonic user turn", [user(), user("again")], "invalid_turn", 1],
    ["assistant before user", [assistant([], "orphan")], "invalid_turn", 0],
  ] as [string, CanonicalRecord[], CanonicalTranscriptErrorCode, number][])("strictly rejects %s", (_name, records, code, index) => {
    rejects(records, code, index);
  });

  test.each([
    ["unsupported version", { ...user(), formatVersion: 2 }, "unsupported_version"],
    ["unknown record kind", { ...user(), kind: "user_message" }, "invalid_record"],
    ["noninteger turn", { ...user(), turnId: 1.5 }, "invalid_record"],
    ["missing payload", { formatVersion: 1, kind: "user_input", turnId: 1 }, "invalid_record"],
    ["non-text result", { ...result("a"), message: { ...result("a").message, text: {} } }, "invalid_record"],
    ["undefined argument", invalidArgument(undefined), "invalid_record"],
    ["NaN argument", invalidArgument(NaN), "invalid_record"],
    ["Date argument", invalidArgument(new Date(0)), "invalid_record"],
    ["bigint argument", invalidArgument(1n), "invalid_record"],
    ["tool block with copied arguments", { ...assistant([call("a")]), message: { text: "", toolCalls: [call("a")], blocks: [{ type: "tool_use", id: "a", args: {} }] } }, "invalid_record"],
    ["unknown block call", { ...assistant(), message: { text: "", blocks: [{ type: "tool_use", id: "missing" }] } }, "invalid_blocks"],
    ["duplicate block reference", { ...assistant([call("a")]), message: { text: "", toolCalls: [call("a")], blocks: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "a" }] } }, "invalid_blocks"],
    ["missing block reference", { ...assistant([call("a")]), message: { text: "", toolCalls: [call("a")], blocks: [] } }, "invalid_blocks"],
  ] as [string, unknown, CanonicalTranscriptErrorCode][])("validates JSON and schema: %s", (_name, record, code) => {
    rejects([user(), record as CanonicalRecord], code, 1);
  });

  test("reader rejects malformed canonical payloads with typed errors", () => {
    expect(() => readCanonicalRecords([event("canonical_message", { formatVersion: 2 })])).toThrow(CanonicalTranscriptError);
  });

  test("rejects cyclic arguments and exhausted turn ids", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    rejects([user(), assistant([{ ...call("a"), args: cyclic as CanonicalToolCall["args"] }])], "invalid_record", 1);
    expect(() => nextCanonicalTurnId([user("last", Number.MAX_SAFE_INTEGER)])).toThrow(CanonicalTranscriptError);
  });
});

// Fixed integer PRNG: failures reproduce without a property-testing dependency.
function random(seed: number): (limit: number) => number {
  let state = seed >>> 0;
  return (limit) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * limit);
  };
}

function generatedLog(rng: (limit: number) => number, sample: number): CanonicalRecord[] {
  const records: CanonicalRecord[] = [];
  for (let turn = 1, turns = 2 + rng(4); turn <= turns; turn++) {
    records.push(user(`input ${sample}/${turn}`, turn), assistant([], "before tools", turn));
    for (let batch = 0, batches = 2 + rng(3); batch < batches; batch++) {
      const calls: CanonicalToolCall[] = Array.from({ length: 2 + rng(4) }, (_, index) => {
        const args = { value: rng(100), nested: [true, null, `arg\n${rng(100)}`] };
        return {
          id: `${sample}_${turn}_${batch}_${index}`, name: `tool_${sample}_${turn}_${batch}_${index}`,
          args, rawArgs: JSON.stringify(args),
        };
      });
      records.push({
        formatVersion: 1, kind: "assistant", turnId: turn,
        message: { text: `batch ${batch}`, toolCalls: calls, blocks: [
          { type: "thinking", thinking: `think ${rng(100)}`, signature: `signature-${rng(100)}` },
          { type: "text", text: `batch ${batch}` }, ...calls.map((tool) => ({ type: "tool_use" as const, id: tool.id })),
        ] },
      });
      const shuffled = [...calls];
      for (let index = shuffled.length - 1; index > 0; index--) {
        const swap = rng(index + 1);
        [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
      }
      for (const tool of shuffled) records.push(result(tool.id, ` bytes\n${rng(100)}\u0000\r\n`, turn, rng(3) === 0));
      records.push(assistant([], `between ${batch}`, turn));
    }
    records.push({ formatVersion: 1, kind: "wrap_up", turnId: turn, message: { text: "wrap up" } }, assistant([], "finished", turn));
  }
  return records;
}

function assertPaired(messages: ConversationMessage[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "assistant" && message.toolCalls?.length) {
      const pending = new Set(message.toolCalls.map((tool) => tool.id));
      expect(pending.size).toBe(message.toolCalls.length);
      for (let count = 0; count < message.toolCalls.length; count++) {
        const next = messages[++index];
        expect(next.role).toBe("tool_result");
        if (next.role !== "tool_result") throw new Error("Noncontiguous batch result");
        expect(pending.delete(next.toolCallId)).toBe(true);
        expect(seen.has(next.toolCallId)).toBe(false);
        seen.add(next.toolCallId);
      }
      expect(pending.size).toBe(0);
    } else {
      expect(message.role).not.toBe("tool_result");
    }
  }
}

test("seeded crash/repair property: 600 random multi-turn logs", async () => {
  const rng = random(0xc0ffee42);
  let pendingCrashes = 0;
  let partialCrashes = 0;
  for (let sample = 0; sample < 600; sample++) {
    const complete = generatedLog(rng, sample);
    const records = complete.slice(0, rng(complete.length + 1));
    const snapshot = JSON.stringify(records);
    const beforeRepair = JSON.stringify(emitCanonicalTranscript(records));
    const appended: CanonicalToolResultRecord[] = [];
    const repaired: CanonicalRecord[] = [...records];
    // Some callbacks throw after k successful durable appends (including k=0).
    const interrupt = rng(2) === 0;
    const k = rng(4);
    const crash = new Error(`seed=0xc0ffee42 sample=${sample} k=${k}`);
    try {
      await repairCanonicalTranscript(repaired, async (record) => {
        if (interrupt && appended.length === k) throw crash;
        appended.push(record);
        repaired.push(record);
      });
    } catch (error) {
      expect(error).toBe(crash);
      partialCrashes++;
    }
    await repairCanonicalTranscript(repaired, (record) => { appended.push(record); repaired.push(record); });
    if (appended.length) pendingCrashes++;
    expect(JSON.stringify(records)).toBe(snapshot);
    expect(JSON.stringify(emitCanonicalTranscript(repaired))).toBe(beforeRepair);
    expect(await repairCanonicalTranscript(repaired, () => { throw new Error(`non-idempotent repair sample=${sample}`); })).toBe(0);
    const continued = [...repaired, user("new input", nextCanonicalTurnId(repaired))];
    const output = emitCanonicalTranscript(continued);
    assertPaired(output);
    expect(JSON.stringify(emitCanonicalTranscript(continued))).toBe(JSON.stringify(output));
    const length = continued.length;
    expect(await repairCanonicalTranscript(continued, (record) => { continued.push(record); })).toBe(0);
    expect(await repairCanonicalTranscript(continued, (record) => { continued.push(record); })).toBe(0);
    expect(continued.length).toBe(length);
    for (const record of appended) {
      expect(record.message).toMatchObject(INTERRUPTED_TOOL_RESULT);
      const batch = records.find((candidate) => candidate.kind === "assistant" && candidate.message.toolCalls?.some((tool) => tool.id === record.message.callId));
      expect(batch).toBeDefined();
      if (!batch) throw new Error("Repair without a matching batch");
      expect(record.turnId).toBe(batch.turnId);
    }
  }
  // Keep the fixed seed honest: it must exercise gaps and interrupted repairs.
  expect(pendingCrashes).toBeGreaterThan(100);
  expect(partialCrashes).toBeGreaterThan(20);
});
