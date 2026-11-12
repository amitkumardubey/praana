import { expect, test } from "bun:test";
import { buildTurns, type CompactionTurn } from "../src/compaction.js";
import { buildSummaryInstruction, checkSummary, SUMMARY_HEADINGS } from "../src/frozen-summary.js";
import type { BatchSummaryAttempt, BatchSummaryPlan, SummaryResult } from "../src/compaction-requests.js";
import type { CanonicalRecord } from "../src/canonical-transcript.js";
import type { StreamRequest } from "../src/llm/types.js";
import { MAX_TOOL_RESULT_CHARS, serializeToolResult } from "../src/llm/serialize.js";
import { estimateTokens } from "../src/token-estimate.js";
import type { Event } from "../src/types.js";

const api = () => import("../src/compaction-requests.js");
const summary = (text = "Continue work.") => SUMMARY_HEADINGS.map((heading, i) => `### ${heading}\n${i === 0 ? text : ""}`).join("\n\n");
const response = (text = summary()): SummaryResult => ({ text, usage: null, toolCalls: [] });
const options = { contextWindowTokens: 3000, effectiveMaxTokens: 512, capTokens: 128, previousSummary: summary("Original work.") };
function live(): StreamRequest {
  return { model: "same-model", provider: "custom", systemPrompt: "large live prefix ".repeat(5000),
    messages: [{ role: "user", content: "TAIL MUST NOT BE FOLDED" }],
    tools: [{ name: "read", description: "large schema ".repeat(1000), parameters: { type: "object" } }],
    maxTokens: 8192, reasoningEffort: "off", temperature: 0.2,
    baseUrl: "https://mock.invalid", headers: { "x-test": "batch" }, signal: new AbortController().signal,
    endpointUrl: "https://mock.invalid/endpoint", query: { a: "b" }, region: "test-region",
  };
}
function foldedTurns(count = 9, size = 2400): CompactionTurn[] {
  const events: Event[] = [];
  function add(id: string, record: CanonicalRecord) {
    events.push({ event_id: id, session_id: "s", timestamp: 1, kind: "canonical_message", actor: "kernel", payload: { ...record } });
  }
  for (let i = 1; i <= count; i++) {
    const base = { formatVersion: 1 as const, turnId: i };
    add(`input-${i}`, { ...base, kind: "user_input", message: { text: `Fold turn ${i}` } });
    add(`assistant-${i}`, { ...base, kind: "assistant", message: { text: "read", toolCalls: [{ id: `call-${i}`, name: "read", args: { path: `file-${i}` } }] } });
    add(`result-${i}`, { ...base, kind: "tool_result", message: { callId: `call-${i}`, toolName: "read", text: `DATA-${i}:` + "x".repeat(size), isError: false } });
  }
  add("tail", { formatVersion: 1, turnId: count + 1, kind: "user_input", message: { text: "tail" } });
  return buildTurns(events).slice(0, -1);
}
async function plan(turns = foldedTurns(), overrides: Partial<typeof options> = {}): Promise<BatchSummaryPlan> {
  const result = (await api()).planBatchSummaries(live(), turns, { ...options, ...overrides });
  expect(result.status).toBe("planned");
  if (result.status !== "planned") throw new Error(JSON.stringify(result));
  return result.plan;
}
// Independent accounting over the messages actually constructed, including JSON escaping.
function tokens(request: StreamRequest): number {
  return estimateTokens(JSON.stringify({ systemPrompt: request.systemPrompt, tools: request.tools })) +
    request.messages.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0);
}

test("batch planner covers complete folded turns once, in order, in bounded capacity-safe batches", async () => {
  const turns = foldedTurns();
  const before = JSON.stringify(turns);
  const planned = await plan(turns);
  expect(planned.batches.length).toBeGreaterThan(2);
  expect(planned.batches.length).toBeLessThanOrEqual(turns.length);
  expect(planned.maxCalls).toBe(2 * planned.batches.length);
  expect(planned.batches.flatMap(batch => batch.eventIds)).toEqual(turns.flatMap(turn => turn.eventIds));
  expect(planned.batches.flatMap(batch => batch.turnIds)).toEqual(turns.map(turn => turn.turnId));
  expect(planned.batches.flatMap(batch => batch.messages)).toEqual(turns.flatMap(turn => turn.messages));
  for (const batch of planned.batches) {
    expect(batch.turnIds.length).toBeGreaterThan(0);
    expect(batch.boundaryEventId).toBe(batch.eventIds.at(-1)!);
    expect(batch.cutDescription).toContain(batch.boundaryEventId);
    expect(batch.budgetedInputTokens + options.effectiveMaxTokens).toBeLessThanOrEqual(options.contextWindowTokens);
  }
  expect(JSON.stringify(turns)).toBe(before);
});

test("batch requests discard the live prefix and tools but keep model and all transport with their own output cap", async () => {
  const { buildBatchSummaryRequest } = await api();
  const source = live();
  const before = JSON.stringify(source);
  const planned = await plan();
  const batch = planned.batches[0];
  const request = buildBatchSummaryRequest(source, batch, { ...options, cutDescription: batch.cutDescription });
  expect(request.messages.at(-1)).toEqual({ role: "user", content: buildSummaryInstruction({ ...options, cutDescription: batch.cutDescription }) });
  expect(request.messages.every(message => message.role === "user" && typeof message.content === "string")).toBe(true);
  expect(request).not.toHaveProperty("systemPrompt");
  expect(request).not.toHaveProperty("tools");
  expect(request).not.toHaveProperty("tool_choice");
  expect(request.maxTokens).toBe(options.effectiveMaxTokens);
  for (const key of Object.keys(source) as (keyof StreamRequest)[]) {
    if (!["messages", "tools", "systemPrompt", "maxTokens"].includes(key)) expect(request[key]).toBe(source[key]);
  }
  expect(tokens(request) + options.effectiveMaxTokens).toBeLessThanOrEqual(options.contextWindowTokens);
  expect(JSON.stringify(request)).not.toContain("TAIL MUST NOT BE FOLDED");
  expect(JSON.stringify(source)).toBe(before);
});

test("batch transcript text is deterministic, bounds tool results and is included in the input budget", async () => {
  const { buildBatchSummaryRequest } = await api();
  const turns = foldedTurns(1, MAX_TOOL_RESULT_CHARS + 1000);
  const batch = { messages: turns[0].messages };
  const request = buildBatchSummaryRequest(live(), batch, { ...options, cutDescription: "cut" });
  const result = batch.messages[2];
  if (result.role !== "tool_result") throw new Error("Expected result");
  expect(request.messages.slice(0, -1)).toEqual([
    { role: "user", content: "user: Fold turn 1" },
    { role: "user", content: 'assistant: read\ntool_call read({"path":"file-1"})' },
    { role: "user", content: `tool_result read: ${serializeToolResult(result.result)}` },
  ]);
  expect(JSON.stringify(request)).not.toContain("x".repeat(MAX_TOOL_RESULT_CHARS + 1));
  expect(buildBatchSummaryRequest(live(), batch, { ...options, cutDescription: "cut" }).messages).toEqual(request.messages);
  const planned = await plan(foldedTurns(2, 500), { contextWindowTokens: 10000 });
  const first = planned.batches[0];
  const budgeted = buildBatchSummaryRequest(planned.template, first, { ...planned.options, cutDescription: first.cutDescription });
  expect(first.budgetedInputTokens).toBe(tokens(budgeted));
});

test("chaining uses each checked whole summary as the next input, publishing only a checked final block", async () => {
  const { nextBatchSummaryRequest } = await api();
  const planned = await plan();
  const attempts: BatchSummaryAttempt[] = [];
  for (let i = 0; i < planned.batches.length; i++) {
    const next = nextBatchSummaryRequest(planned, attempts);
    expect(next.status).toBe("request");
    if (next.status !== "request") throw new Error("Expected batch request");
    expect(next).toMatchObject({ batchIndex: i, attempt: 0 });
    expect(next).not.toHaveProperty("summary");
    const instruction = next.request.messages.at(-1)!;
    expect(instruction).toEqual({ role: "user", content: buildSummaryInstruction({ ...options, previousSummary: i ? attempts[i - 1].result.text : options.previousSummary, cutDescription: planned.batches[i].cutDescription }) });
    expect(tokens(next.request) + options.effectiveMaxTokens).toBeLessThanOrEqual(options.contextWindowTokens);
    attempts.push({ result: response(summary(`Merged through batch ${i}.`)) });
  }
  const complete = nextBatchSummaryRequest(planned, attempts);
  expect(complete).toEqual({ status: "complete", summary: attempts.at(-1)!.result.text, boundaryEventId: planned.batches.at(-1)!.boundaryEventId });
  if (complete.status !== "complete") throw new Error("Expected completion");
  expect(checkSummary(complete.summary, options).ok).toBe(true);
  expect(attempts.length).toBeLessThanOrEqual(planned.maxCalls);
});

test("a later invalid batch gets one repair; a failed repair exposes no partial summary or boundary", async () => {
  const { nextBatchSummaryRequest } = await api();
  const planned = await plan();
  const attempts: BatchSummaryAttempt[] = [{ result: response() }, { result: response("missing schema") }];
  const before = JSON.stringify(attempts);
  const next = nextBatchSummaryRequest(planned, attempts);
  expect(next).toMatchObject({ status: "request", batchIndex: 1, attempt: 1 });
  expect(next).not.toHaveProperty("summary");
  expect(JSON.stringify(attempts)).toBe(before);
  const failed = nextBatchSummaryRequest(planned, [attempts[0], { ...attempts[1], repair: response("still invalid") }]);
  expect(failed).toMatchObject({ status: "failed", batchIndex: 1 });
  expect(failed).not.toHaveProperty("summary");
  expect(failed).not.toHaveProperty("boundaryEventId");
  expect(nextBatchSummaryRequest(planned, [])).toMatchObject({ status: "request", batchIndex: 0, attempt: 0 });
});

test("a successful repair replaces the whole block for the next batch", async () => {
  const { nextBatchSummaryRequest } = await api();
  const planned = await plan();
  const repaired = summary("Repaired whole block.");
  const next = nextBatchSummaryRequest(planned, [{ result: response("bad block"), repair: response(repaired) }]);
  expect(next).toMatchObject({ status: "request", batchIndex: 1, attempt: 0 });
  if (next.status !== "request") throw new Error("Expected next batch");
  const instruction = next.request.messages.at(-1)!;
  expect(instruction).toEqual({ role: "user", content: buildSummaryInstruction({ ...options, previousSummary: repaired, cutDescription: planned.batches[1].cutDescription }) });
  expect(JSON.stringify(next.request)).not.toContain("bad block");
});

test("all batches may repair once and the planned maximum is exactly twice the batch count", async () => {
  const { nextBatchSummaryRequest } = await api();
  const planned = await plan();
  const attempts: BatchSummaryAttempt[] = [];
  let calls = 0;
  for (let i = 0; i < planned.batches.length; i++) {
    expect(nextBatchSummaryRequest(planned, attempts)).toMatchObject({ status: "request", batchIndex: i, attempt: 0 });
    calls++;
    attempts.push({ result: response("invalid") });
    const repair = nextBatchSummaryRequest(planned, attempts);
    expect(repair).toMatchObject({ status: "request", batchIndex: i, attempt: 1 });
    if (repair.status !== "request") throw new Error("Expected repair");
    expect(tokens(repair.request) + options.effectiveMaxTokens).toBeLessThanOrEqual(options.contextWindowTokens);
    calls++;
    attempts[i].repair = response(summary(`Repaired batch ${i}.`));
  }
  expect(nextBatchSummaryRequest(planned, attempts).status).toBe("complete");
  expect(calls).toBe(planned.maxCalls);
});

test("an oversized single turn is not foldable, never split, and no earlier partial plan is returned", async () => {
  const { planBatchSummaries } = await api();
  const turns = foldedTurns(4);
  turns[2].messages.push({ role: "user", content: "huge".repeat(10000) });
  const result = planBatchSummaries(live(), turns, options);
  expect(result).toMatchObject({ status: "not_foldable", turnId: 3, reason: "oversized_turn" });
  expect(result).not.toHaveProperty("plan");
  expect(result).not.toHaveProperty("batches");
  expect(result).toHaveProperty("message", expect.stringMatching(/stub|capacity/i));
});

test("fixed instruction or previous-summary overhead can make a turn not foldable", async () => {
  const { planBatchSummaries } = await api();
  expect(planBatchSummaries(live(), foldedTurns(1, 1), { ...options, previousSummary: "old".repeat(10000) })).toMatchObject({ status: "not_foldable", turnId: 1 });
  expect(planBatchSummaries(live(), foldedTurns(1, 1), { ...options, contextWindowTokens: 520 })).toMatchObject({ status: "not_foldable", turnId: 1 });
});

test("planner rejects invalid capacities, caps, empty/in-flight units and duplicate ids without model calls", async () => {
  const { planBatchSummaries } = await api();
  for (const reserve of [3000, 4000]) expect(planBatchSummaries(live(), foldedTurns(1), { ...options, effectiveMaxTokens: reserve })).toMatchObject({ status: "capacity_error", kind: "reserve_exceeds_window" });
  expect(planBatchSummaries(live(), foldedTurns(1), { ...options, effectiveMaxTokens: -1 })).toMatchObject({ status: "capacity_error", kind: "invalid_capacity" });
  for (const capTokens of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) expect(() => planBatchSummaries(live(), foldedTurns(1), { ...options, capTokens })).toThrow(RangeError);
  const turns = foldedTurns(2);
  expect(() => planBatchSummaries(live(), [], options)).toThrow(RangeError);
  expect(() => planBatchSummaries(live(), [{ ...turns[0], completed: false }], options)).toThrow(RangeError);
  expect(() => planBatchSummaries(live(), [turns[0], turns[0]], options)).toThrow(RangeError);
});

test("batch planning remeasures native messages rather than trusting stale per-turn estimates", async () => {
  const turns = foldedTurns();
  const normal = await plan(turns);
  const stale = await plan(turns.map(turn => ({ ...turn, estimatedTokens: 0 })));
  expect(stale.batches).toEqual(normal.batches);
});

test("previous-summary allowance covers worst-case JSON escaping at the raw markdown cap", async () => {
  const { nextBatchSummaryRequest } = await api();
  const planned = await plan();
  const base = summary();
  let escaped = base;
  while (estimateTokens(escaped + "\u0000") <= options.capTokens) escaped += "\u0000";
  expect(checkSummary(escaped, options).ok).toBe(true);
  for (let i = 1; i < planned.batches.length; i++) {
    const next = nextBatchSummaryRequest(planned, Array.from({ length: i }, () => ({ result: response(escaped) })));
    expect(next.status).toBe("request");
    if (next.status !== "request") throw new Error("Expected admitted request");
    expect(tokens(next.request) + options.effectiveMaxTokens).toBeLessThanOrEqual(options.contextWindowTokens);
  }
});

test("repair builder preserves request fields and includes failed markdown and exact validation feedback", async () => {
  const { buildSameModelSummaryRequest, buildSummaryRepairRequest } = await api();
  const request = buildSameModelSummaryRequest({ ...live(), systemPrompt: "small", tools: [] }, { cutDescription: "cut", capTokens: 128 });
  const bad = response("invalid markdown");
  const repair = buildSummaryRepairRequest(request, bad, { ...options, contextWindowTokens: 10000, attempt: 0 });
  expect(repair).toMatchObject({ status: "repair" });
  if (repair.status !== "repair") throw new Error("Expected repair");
  expect(repair.request.messages.slice(0, -2)).toEqual(request.messages);
  expect(repair.request.messages.at(-2)).toEqual({ role: "assistant", content: bad.text });
  const instruction = repair.request.messages.at(-1)!;
  if (instruction.role !== "user" || typeof instruction.content !== "string") throw new Error("Expected feedback");
  for (const failure of checkSummary(bad.text, options).failures) expect(instruction.content).toContain(failure.message);
  for (const key of Object.keys(request) as (keyof StreamRequest)[]) if (key !== "messages") expect(repair.request[key]).toBe(request[key]);
  expect(buildSummaryRepairRequest(request, response(), { ...options, attempt: 0 })).toEqual({ status: "not_needed" });
  expect(buildSummaryRepairRequest(request, bad, { ...options, attempt: 1 })).toMatchObject({ status: "failed", reason: "invalid_summary" });
});

test("tool calls make primary and repair summaries failed attempts even with otherwise valid markdown", async () => {
  const { summaryResponseHasToolCalls, buildSummaryRepairRequest, nextBatchSummaryRequest } = await api();
  const tool = { ...response(), toolCalls: [{ id: "call", name: "read", args: {} }] };
  expect(summaryResponseHasToolCalls(tool)).toBe(true);
  expect(summaryResponseHasToolCalls(response())).toBe(false);
  expect(buildSummaryRepairRequest(live(), tool, { ...options, attempt: 0 })).toMatchObject({ status: "failed", reason: "tool_calls" });
  const planned = await plan();
  for (const attempts of [[{ result: tool }], [{ result: response("bad"), repair: tool }]]) {
    expect(nextBatchSummaryRequest(planned, attempts)).toMatchObject({ status: "failed", reason: "tool_calls", batchIndex: 0 });
  }
});

test("oversized repair input and over-cap repaired output fail atomically", async () => {
  const { buildBatchSummaryRequest, buildSummaryRepairRequest, nextBatchSummaryRequest } = await api();
  const planned = await plan();
  const batch = planned.batches[0];
  const request = buildBatchSummaryRequest(planned.template, batch, { ...options, cutDescription: batch.cutDescription });
  expect(buildSummaryRepairRequest(request, response("x".repeat(40000)), { ...options, attempt: 0 })).toMatchObject({ status: "failed", reason: "repair_exceeds_capacity" });
  const overCap = summary("x".repeat(2000));
  expect(nextBatchSummaryRequest(planned, [{ result: response("bad"), repair: response(overCap) }])).toMatchObject({ status: "failed", reason: "invalid_summary" });
});

test("out-of-sequence extra results and unnecessary repairs cannot publish a completed summary", async () => {
  const { nextBatchSummaryRequest } = await api();
  const planned = await plan();
  for (const attempts of [
    Array.from({ length: planned.batches.length + 1 }, () => ({ result: response() })),
    [{ result: response(), repair: response() }],
    [{ result: response("bad") }, { result: response() }],
  ]) {
    const result = nextBatchSummaryRequest(planned, attempts);
    expect(result).toMatchObject({ status: "failed", reason: "invalid_attempts" });
    expect(result).not.toHaveProperty("summary");
  }
});
