import { afterEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalWriter } from "../src/canonical-transcript.js";
import { buildTurns, materializeHistory, runCompaction, type CompactionOutcome } from "../src/compaction.js";
import { EventLog } from "../src/event-log.js";
import { appendCommit, buildSummaryInstruction, checkSummary, minimumValidSummary, readCommits, renderSummaryMessage, restoreFrozenStateFromLog, SESSION_START_EPOCH, summaryCapTokens } from "../src/frozen-summary.js";
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
  return minimumValidSummary().replace("\nok", () => `\n${active}`);
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
      resetEpoch: SESSION_START_EPOCH,
      baseBoundaryEventId: null,
      previousSummarySha256: null,
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
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_not_beneficial" });
  expectNoDiscard(outcome);
  expect(messages(log)).toEqual(before);
  expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
});

test("benefit and capacity name and compare their distinct best cases", () => {
  const source = readFileSync(new URL("../src/compaction.ts", import.meta.url), "utf8");
  expect(source.includes("const foldAloneBestCase = estimateRequestTokens(frame, unstubbedInFlightMessages) + minSummaryMessageTokens;")).toBe(true);
  expect(source.includes("let stubbedFoldBestCase = foldAloneBestCase;")).toBe(true);
  expect(source.includes("stubbedFoldBestCase = estimateRequestTokens(frame, inFlightMinMessages) + minSummaryMessageTokens;")).toBe(true);
  expect(source.includes("foldAloneBestCase >= preFoldFill().inputTokens")).toBe(true);
  expect(source.includes("stubbedFoldBestCase > initialFill.usableTokens")).toBe(true);
  expect(source).not.toMatch(/\b(?:bestCaseTokens|minInFlightTokens)\b/);
});

test.each([
  { completed: "old", calls: 0, status: "stubbed" },
  { completed: "C".repeat(700), calls: 1, status: "rewritten" },
])("best cases keep benefit independent of stubbing for $status", async (scenario) => {
  const { log, writer, current } = await nearCapacity(scenario.completed, 4800);
  await writer.assistant(current, { role: "assistant", content: "", toolCalls: [{ id: "newest", name: "shell", args: {} }] });
  await writer.result(current, "newest", "shell", "ok", false);
  const beforeTokens = inputTokens(messages(log));
  const tail = buildTurns(log).at(-1)!.messages;
  const foldAlone = inputTokens([renderSummaryMessage(summary()), ...tail]);
  const stubbedTail = tail.map((message): ConversationMessage => message.role === "tool_result" && message.toolCallId === "call"
    ? { ...message, result: "s" } : message);
  const stubbedFold = inputTokens([renderSummaryMessage(summary()), ...stubbedTail]);
  expect(foldAlone).toBeGreaterThan(usableTokens);
  expect(stubbedFold).toBeLessThan(usableTokens);
  expect(foldAlone < beforeTokens).toBe(scenario.calls === 1);
  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options: { ...options, stubKeepRecent: 1 },
    planStubs: (candidates) => candidates.map((candidate) => ({ eventId: candidate.eventId, stubText: "s" })),
    runSummary: async () => { calls++; return { text: summary(), finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(scenario.calls);
  expect(outcome.status).toBe(scenario.status);
  expectNoDiscard(outcome);
});

test("an impossible minimum remains fold_not_possible even when the fold also cannot shrink", async () => {
  const { log } = await nearCapacity("old", 4400);
  expect(inputTokens(messages(log))).toBeLessThanOrEqual(usableTokens);
  const minimumFold = inputTokens([renderSummaryMessage(summary()), ...buildTurns(log).at(-1)!.messages]);
  expect(minimumFold).toBeGreaterThan(usableTokens);
  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options,
    runSummary: async () => { calls++; return { text: summary(), finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(0);
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_not_possible" });
  expectNoDiscard(outcome);
});

test("an insufficient summary cap remains fold_not_possible", async () => {
  const { log } = await nearCapacity("C".repeat(520), 1);
  const beforeTokens = inputTokens(messages(log));
  expect(beforeTokens).toBeGreaterThanOrEqual(224 * 0.80);
  expect(beforeTokens).toBeLessThanOrEqual(224);
  expect(summaryCapTokens(224)).toBeLessThan(estimateTokens(summary()));
  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens: 424, options,
    runSummary: async () => { calls++; return { text: summary(), finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(0);
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_not_possible" });
  expectNoDiscard(outcome);
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

test.each([168, 172])("pre-check estimate matches minimumValidSummary at the benefit boundary for %i bytes", async (completedSize) => {
  const frozen = await import("../src/frozen-summary.js");
  expect(frozen.minimumValidSummary).toBeFunction();
  const minimum = frozen.minimumValidSummary();
  const source = readFileSync(new URL("../src/compaction.ts", import.meta.url), "utf8");
  expect(source.includes("const minValidSummary = minimumValidSummary();")).toBe(true);
  const { log } = await nearCapacity("C".repeat(completedSize), 3400);
  const before = inputTokens(messages(log));
  const best = inputTokens([renderSummaryMessage(minimum), ...buildTurns(log).at(-1)!.messages]);
  expect(before - best).toBe((completedSize - 168) / 4);
  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options,
    runSummary: async () => { calls++; return { text: minimum, finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(before > best ? 1 : 0);
  expect(outcome.status).toBe(before > best ? "rewritten" : "unchanged_fits");
  expectNoDiscard(outcome);
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
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_not_beneficial" });
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
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_not_beneficial", summaryDiscarded: true });
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

test("in-flight stubbing cannot make a growing fold look beneficial", async () => {
  const { log, writer, current } = await nearCapacity("C".repeat(264), 3000);
  for (let i = 0; i < 3; i++) {
    const id = `recent-${i}`;
    await writer.assistant(current, { role: "assistant", content: "", toolCalls: [{ id, name: "shell", args: {} }] });
    await writer.result(current, id, "shell", "ok", false);
  }
  const before = messages(log);
  const beforeTokens = inputTokens(before);
  const accepted = summary("D".repeat(380));
  const foldOnlyTokens = inputTokens([renderSummaryMessage(accepted), ...buildTurns(log).at(-1)!.messages]);
  expect(beforeTokens / usableTokens).toBeGreaterThanOrEqual(0.80);
  expect(beforeTokens).toBeLessThanOrEqual(usableTokens);
  expect(foldOnlyTokens).toBeGreaterThan(beforeTokens);
  const planStubs = mock((candidates: readonly import("../src/compaction.js").StubCandidate[]) =>
    candidates.map((candidate) => ({ eventId: candidate.eventId, stubText: "s" })));
  let calls = 0;
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options, planStubs,
    runSummary: async () => { calls++; return { text: accepted, finishReason: "stop", usage: null, toolCalls: [] }; },
  });
  expect(calls).toBe(1);
  // Only the unfolded fallback plans stubs; an uncommittable fold must not plan them too.
  expect(planStubs).toHaveBeenCalledTimes(1);
  expect(outcome).toMatchObject({ status: "stubbed", summaryDiscarded: true });
  expectDiscarded(outcome, log, accepted);
  if (outcome.status !== "stubbed") throw new Error(JSON.stringify(outcome));
  expect(outcome.fill.inputTokens).toBeLessThan(beforeTokens);
  expect(outcome.state.summary).toBeNull();
  expect(outcome.state.boundaryEventId).toBeNull();
  expect(messages(log).slice(0, 2)).toEqual(before.slice(0, 2));
  expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(1);
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
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_not_beneficial", summaryDiscarded: true });
  expectDiscarded(outcome, log, accepted);
  expect(inputTokens(messages(log))).toBe(beforeTokens);
  expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
});

test.each([
  { completed: "old", resultSize: 4400, accepted: summary(), reason: "fold_not_possible", calls: 0 },
  { completed: "C".repeat(220), resultSize: 4100, accepted: summary("D".repeat(380)), reason: "fold_not_beneficial", calls: 1 },
  { completed: "C".repeat(700), resultSize: 3000, accepted: summary(), reason: "fold_insufficient", calls: 1 },
])("discard reason gives benefit precedence over fit: $reason", async (scenario) => {
  const { log, writer, current } = await nearCapacity(scenario.completed, scenario.resultSize);
  if (scenario.reason === "fold_insufficient") {
    await writer.assistant(current, { role: "assistant", content: "", toolCalls: [{ id: "newest", name: "shell", args: {} }] });
    await writer.result(current, "newest", "shell", "ok", false);
  }
  const before = inputTokens(messages(log));
  const foldOnly = inputTokens([renderSummaryMessage(scenario.accepted), ...buildTurns(log).at(-1)!.messages]);
  expect(before).toBeLessThanOrEqual(usableTokens);
  expect(foldOnly < before).toBe(scenario.reason === "fold_insufficient");
  if (scenario.reason !== "fold_insufficient") expect(foldOnly).toBeGreaterThan(usableTokens);
  const runSummary = mock(async () => ({ text: scenario.accepted, finishReason: "stop", usage: null, toolCalls: [] }));
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options: { ...options, stubKeepRecent: 1 },
    // Same raw token estimate, but JSON escaping grows the request: a useful fold can still fail final fit.
    planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: "\\".repeat(c.text.length) })),
    runSummary,
  });
  expect(runSummary).toHaveBeenCalledTimes(scenario.calls);
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: scenario.reason });
  if (scenario.calls) expectDiscarded(outcome, log, scenario.accepted);
  else expectNoDiscard(outcome);
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
      resetEpoch: SESSION_START_EPOCH,
      baseBoundaryEventId: null,
      previousSummarySha256: null,
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

test("discard metadata is attached by one private helper for all three outcomes", () => {
  const source = readFileSync(new URL("../src/compaction.ts", import.meta.url), "utf8");
  expect(source.match(/function withDiscardedSummary\b/g) ?? []).toHaveLength(1);
  expect(source.match(/withDiscardedSummary\(/g) ?? []).toHaveLength(3);
  expect(source.match(/summaryDiscarded:\s*true,\s*discardedSummary\b/g) ?? []).toHaveLength(1);
  expect(source).not.toMatch(/\.(?:summaryDiscarded|discardedSummary)\s*=/);
});

test.each(["unchanged_fits", "stubbed", "capacity_error"] as const)("discarded summary records the frozen base for %s", async (status) => {
  const { log, writer } = openLog();
  log.append({ kind: "system_note", actor: "kernel", payload: { type: "reset_boundary", command: "/clear" } });
  const resetEpoch = log.readAll({ includeInternal: true }).at(-1)!.event_id;
  const seed = await writer.startTurn("seed");
  await writer.assistant(seed, { role: "assistant", content: "done" });
  const old = await writer.startTurn("C".repeat(220));
  const baseBoundary = buildTurns(log)[0].eventIds.at(-1)!;
  const previousSummary = summary("base\n雪");
  expect(appendCommit(log, {
    formatVersion: 1, resetEpoch, generation: 1,
    boundaryEventId: baseBoundary, summary: previousSummary, stubSet: [],
    summaryRequest: {
      cutDescription: "seed cut", capTokens: 150,
      instructionSha256: createHash("sha256").update(buildSummaryInstruction({ cutDescription: "seed cut", capTokens: 150 })).digest("hex"),
      usage: null,
    },
  })).toEqual({ status: "committed" });
  await writer.assistant(old, { role: "assistant", content: "done" });
  const current = await writer.startTurn("now");
  await writer.assistant(current, { role: "assistant", content: "running", toolCalls: [{ id: "call", name: "shell", args: {} }] });
  await writer.result(current, "call", "shell", "R".repeat(status === "capacity_error" ? 4300 : 3400), false);
  if (status === "stubbed") {
    await writer.assistant(current, { role: "assistant", content: "", toolCalls: [{ id: "newest", name: "shell", args: {} }] });
    await writer.result(current, "newest", "shell", "ok", false);
  }
  const base = restoreFrozenStateFromLog(log);
  if (!base.ok) throw base.error;
  const boundaryEventId = buildTurns(log)[1].eventIds.at(-1)!;
  const accepted = summary("D".repeat(380));
  const outcome = await runCompaction({
    log, liveRequest, contextWindowTokens, options: { ...options, stubKeepRecent: 1 },
    runSummary: async () => ({ text: accepted, finishReason: "stop", usage: null, toolCalls: [] }),
  });
  expect(outcome.status).toBe(status);
  expect(outcome).toMatchObject({
    summaryDiscarded: true,
    discardedSummary: {
      boundaryEventId, resetEpoch, baseBoundaryEventId: base.state.boundaryEventId,
      previousSummarySha256: createHash("sha256").update(previousSummary).digest("hex"),
      text: accepted,
    },
  });
  if (!("discardedSummary" in outcome) || !outcome.discardedSummary) throw new Error("Expected discarded summary");
  const currentState = restoreFrozenStateFromLog(log);
  if (!currentState.ok) throw currentState.error;
  expect(currentState.state.summary).toBe(previousSummary);
  expect(currentState.state.boundaryEventId).toBe(baseBoundary);
  expect(outcome.discardedSummary).not.toHaveProperty("baseGeneration");
  const reuseIdentity = (state: typeof base.state) => ({
    resetEpoch: state.resetEpoch,
    baseBoundaryEventId: state.boundaryEventId,
    previousSummarySha256: state.summary === null ? null : createHash("sha256").update(state.summary).digest("hex"),
  });
  // A stubs-only commit changes generation, not the summary's reusable base.
  expect(outcome.discardedSummary).toMatchObject(reuseIdentity(currentState.state));
  expect(currentState.state.generation).toBe(base.state.generation + (status === "stubbed" ? 1 : 0));

  // Move only the cut, preserving summary bytes, so the boundary alone invalidates reuse.
  expect(appendCommit(log, {
    formatVersion: 1, ...currentState.state, generation: currentState.state.generation + 1,
    boundaryEventId, stubSet: [], summaryRequest: base.state.summaryRequest,
  })).toEqual({ status: "committed" });
  const folded = restoreFrozenStateFromLog(log);
  if (!folded.ok) throw folded.error;
  expect(outcome.discardedSummary).not.toMatchObject(reuseIdentity(folded.state));
  expect(outcome.discardedSummary.baseBoundaryEventId).not.toBe(folded.state.boundaryEventId);
  expect(outcome.discardedSummary.previousSummarySha256).toBe(reuseIdentity(folded.state).previousSummarySha256);

  log.append({ kind: "system_note", actor: "kernel", payload: { type: "reset_boundary", command: "/clear" } });
  const reset = restoreFrozenStateFromLog(log);
  if (!reset.ok) throw reset.error;
  expect(outcome.discardedSummary).not.toMatchObject(reuseIdentity(reset.state));
  expect(outcome.discardedSummary.resetEpoch).not.toBe(reset.state.resetEpoch);
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
