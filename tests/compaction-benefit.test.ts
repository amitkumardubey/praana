import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalWriter } from "../src/canonical-transcript.js";
import { buildTurns, materializeHistory, runCompaction, type CompactionOutcome } from "../src/compaction.js";
import { EventLog } from "../src/event-log.js";
import { checkSummary, readCommits, renderSummaryMessage, restoreFrozenStateFromLog, SUMMARY_HEADINGS, summaryCapTokens } from "../src/frozen-summary.js";
import type { ConversationMessage, StreamRequest } from "../src/llm/types.js";
import { estimateTokens } from "../src/token-estimate.js";

const resources: { root: string; log: EventLog }[] = [];
afterEach(() => {
  for (const { root, log } of resources.splice(0)) {
    log.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function openLog() {
  const root = mkdtempSync(join(tmpdir(), "compaction-benefit-"));
  const log = new EventLog("benefit", root);
  resources.push({ root, log });
  const writer = new CanonicalWriter(log, (error) => { throw error; });
  return { log, writer };
}

function summary(active = "ok"): string {
  return SUMMARY_HEADINGS.map((heading, index) => `### ${heading}${index === 0 ? `\n${active}` : ""}`).join("\n\n");
}

const liveRequest: StreamRequest = { model: "claude-sonnet-4-20250514", provider: "anthropic", messages: [] };
const options = { effectiveMaxTokens: 200, tailTurns: 0 };
const contextWindowTokens = 1400;
const usableTokens = contextWindowTokens - options.effectiveMaxTokens;

// Independent full-request accounting for these text-only fixtures.
function inputTokens(messages: readonly ConversationMessage[]): number {
  return estimateTokens("{}") + messages.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0);
}

function messages(log: EventLog): ConversationMessage[] {
  const restored = restoreFrozenStateFromLog(log);
  if (!restored.ok) throw restored.error;
  const materialized = materializeHistory(restored.state, log);
  if (!materialized.ok) throw materialized.error;
  return materialized.messages;
}

async function nearCapacity(completedText: string, resultSize: number) {
  const { log, writer } = openLog();
  const old = await writer.startTurn(completedText);
  await writer.assistant(old, { role: "assistant", content: "done" });
  const current = await writer.startTurn("now");
  await writer.assistant(current, {
    role: "assistant", content: "running",
    toolCalls: [{ id: "call", name: "shell", args: {} }],
  });
  await writer.result(current, "call", "shell", "R".repeat(resultSize), false);
  return { log, writer, current };
}

function expectNoDiscard(outcome: CompactionOutcome) {
  expect(outcome).not.toHaveProperty("summaryDiscarded");
  expect(outcome).not.toHaveProperty("discardedSummary");
}

function expectDiscarded(outcome: CompactionOutcome, log: EventLog, text: string) {
  const boundaryEventId = buildTurns(log)[0].eventIds.at(-1)!;
  expect(outcome).toMatchObject({
    summaryDiscarded: true,
    discardedSummary: {
      boundaryEventId,
      text,
      request: {
        cutDescription: `through canonical event ${boundaryEventId} (end of turn 1)`,
        capTokens: summaryCapTokens(usableTokens),
        instructionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        usage: null,
      },
    },
  });
}

test("a tiny completed turn skips the paid summary when even the minimum cannot shrink", async () => {
  const { log } = await nearCapacity("old", 4100);
  const before = messages(log);
  const beforeTokens = inputTokens(before);
  const accepted = summary("D".repeat(380));
  const foldedTokens = inputTokens([renderSummaryMessage(accepted), ...buildTurns(log).at(-1)!.messages]);
  expect(beforeTokens / usableTokens).toBeGreaterThanOrEqual(0.80);
  expect(beforeTokens).toBeLessThanOrEqual(usableTokens);
  expect(checkSummary(accepted, { capTokens: summaryCapTokens(usableTokens) }).ok).toBe(true);
  expect(foldedTokens).toBeGreaterThan(usableTokens);

  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options,
    runSummary: async () => { calls++; return { text: accepted, finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(0);
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_not_possible" });
  expectNoDiscard(outcome);
  expect(messages(log)).toEqual(before);
  expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
});

test("a useful minimum still pays for a summary", async () => {
  const { log } = await nearCapacity("C".repeat(700), 3400);
  const beforeTokens = inputTokens(messages(log));
  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options,
    runSummary: async () => { calls++; return { text: summary(), finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(1);
  expect(outcome.status).toBe("rewritten");
  expectNoDiscard(outcome);
  expect(inputTokens(messages(log))).toBeLessThan(beforeTokens);
});

test("an equal-size minimum skips the paid summary", async () => {
  const { log } = await nearCapacity("C".repeat(168), 3400);
  const beforeTokens = inputTokens(messages(log));
  const bestTokens = inputTokens([renderSummaryMessage(summary()), ...buildTurns(log).at(-1)!.messages]);
  expect(bestTokens).toBe(beforeTokens);
  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options,
    runSummary: async () => { calls++; return { text: summary(), finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(0);
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_not_possible" });
  expectNoDiscard(outcome);
});

test("benefit is measured after stale stubs, not against the original request", async () => {
  const { log, writer } = openLog();
  const old = await writer.startTurn("");
  await writer.assistant(old, { role: "assistant", content: "", toolCalls: [{ id: "c", name: "s", args: {} }] });
  await writer.result(old, "c", "s", "O".repeat(4000), false);
  const current = await writer.startTurn("R".repeat(4000));
  await writer.assistant(current, { role: "assistant", content: "" });
  const originalTokens = inputTokens(messages(log));
  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options: { ...options, stubMinTokens: 50 },
    planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: "" })),
    runSummary: async () => { calls++; return { text: summary(), finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(0);
  expect(outcome.status).toBe("stubbed");
  if (outcome.status !== "stubbed") throw new Error(JSON.stringify(outcome));
  const bestTokens = inputTokens([renderSummaryMessage(summary()), ...buildTurns(log).at(-1)!.messages]);
  expect(outcome.fill.inputTokens).toBeLessThan(originalTokens);
  expect(bestTokens).toBeGreaterThanOrEqual(outcome.fill.inputTokens);
  expect(outcome.state.summary).toBeNull();
  expectNoDiscard(outcome);
});

test("an accepted equal-size fold is discarded", async () => {
  const { log } = await nearCapacity("C".repeat(264), 3400);
  const beforeTokens = inputTokens(messages(log));
  const accepted = summary("D".repeat(100));
  const foldedTokens = inputTokens([renderSummaryMessage(accepted), ...buildTurns(log).at(-1)!.messages]);
  expect(foldedTokens).toBe(beforeTokens);
  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options,
    runSummary: async () => { calls++; return { text: accepted, finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(1);
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_insufficient", summaryDiscarded: true });
  expectDiscarded(outcome, log, accepted);
  expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
});

test("a fold must shrink relative to stale stubs even when it beats the original request", async () => {
  const { log, writer } = openLog();
  const old = await writer.startTurn("C".repeat(100));
  await writer.assistant(old, { role: "assistant", content: "", toolCalls: [{ id: "c", name: "s", args: {} }] });
  await writer.result(old, "c", "s", "O".repeat(4000), false);
  const current = await writer.startTurn("R".repeat(3800));
  await writer.assistant(current, { role: "assistant", content: "" });
  const originalTokens = inputTokens(messages(log));
  const accepted = summary("D".repeat(380));
  const foldedTokens = inputTokens([renderSummaryMessage(accepted), ...buildTurns(log).at(-1)!.messages]);
  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options: { ...options, stubMinTokens: 50 },
    planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: "" })),
    runSummary: async () => { calls++; return { text: accepted, finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(1);
  expect(outcome).toMatchObject({ status: "stubbed", summaryDiscarded: true });
  expectDiscarded(outcome, log, accepted);
  if (outcome.status !== "stubbed") throw new Error(JSON.stringify(outcome));
  expect(outcome.fill.inputTokens).toBeLessThan(foldedTokens);
  expect(foldedTokens).toBeLessThan(originalTokens);
  expect(foldedTokens).toBeLessThanOrEqual(usableTokens);
  expect(outcome.state.summary).toBeNull();
});

test("a fitting fold that grows the request is discarded", async () => {
  const { log } = await nearCapacity("C".repeat(220), 3400);
  const beforeTokens = inputTokens(messages(log));
  const accepted = summary("D".repeat(380));
  const foldedTokens = inputTokens([renderSummaryMessage(accepted), ...buildTurns(log).at(-1)!.messages]);
  expect(beforeTokens / usableTokens).toBeGreaterThanOrEqual(0.80);
  expect(foldedTokens).toBeGreaterThan(beforeTokens);
  expect(foldedTokens).toBeLessThanOrEqual(usableTokens);
  expect(checkSummary(accepted, { capTokens: summaryCapTokens(usableTokens) }).ok).toBe(true);

  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options,
    runSummary: async () => { calls++; return { text: accepted, finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(1);
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_insufficient", summaryDiscarded: true });
  expectDiscarded(outcome, log, accepted);
  expect(inputTokens(messages(log))).toBe(beforeTokens);
  expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
});

test("a capacity error exposes the accepted summary and its paid request metadata", async () => {
  const { log } = await nearCapacity("C".repeat(220), 4300);
  const boundaryEventId = buildTurns(log)[0].eventIds.at(-1)!;
  const accepted = summary("D".repeat(380));
  const usage = { input: 123, output: 99, totalTokens: 222 };
  expect(inputTokens(messages(log))).toBeGreaterThan(usableTokens);
  expect(checkSummary(accepted, { capTokens: summaryCapTokens(usableTokens) }).ok).toBe(true);
  let calls = 0;
  let instruction = "";
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options,
    runSummary: async (request) => {
      calls++;
      const last = request.messages.at(-1)!;
      if (last.role === "tool_result" || typeof last.content !== "string") throw new Error("Expected summary instruction");
      instruction = last.content;
      return { text: accepted, finishReason: "stop", usage, toolCalls: [] };
    },
  });
  expect(calls).toBe(1);
  expect(outcome).toMatchObject({
    status: "capacity_error", kind: "request_exceeds_capacity", summaryDiscarded: true,
    discardedSummary: {
      boundaryEventId,
      text: accepted,
      request: {
        cutDescription: `through canonical event ${boundaryEventId} (end of turn 1)`,
        capTokens: summaryCapTokens(usableTokens),
        instructionSha256: createHash("sha256").update(instruction).digest("hex"),
        usage,
      },
    },
  });
  expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
});

test.each([
  { name: "below trigger", completedSize: 220, resultSize: 1, status: "noop", calls: 0 },
  { name: "no completed turns", completedSize: null, resultSize: 3800, status: "unchanged_fits", calls: 0 },
  { name: "summary failure", completedSize: 220, resultSize: 3400, status: "summary_failed_fits", calls: 1 },
  { name: "unfoldable overflow", completedSize: 220, resultSize: 4800, status: "capacity_error", calls: 0 },
  { name: "invalid reserve", completedSize: 220, resultSize: 3400, status: "capacity_error", calls: 0 },
])("$name does not expose a discarded summary", async (scenario) => {
  const { log, writer } = openLog();
  if (scenario.completedSize !== null) {
    const old = await writer.startTurn("C".repeat(scenario.completedSize));
    await writer.assistant(old, { role: "assistant", content: "done" });
  }
  const current = await writer.startTurn("now");
  await writer.assistant(current, {
    role: "assistant", content: "running", toolCalls: [{ id: "call", name: "shell", args: {} }],
  });
  await writer.result(current, "call", "shell", "R".repeat(scenario.resultSize), false);
  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens,
    options: scenario.name === "invalid reserve" ? { ...options, effectiveMaxTokens: contextWindowTokens } : options,
    runSummary: async () => { calls++; throw new Error("unavailable"); },
  });
  expect(calls).toBe(scenario.calls);
  expect(outcome.status).toBe(scenario.status);
  expectNoDiscard(outcome);
  expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
});
