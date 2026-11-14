import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalWriter } from "../src/canonical-transcript.js";
import { buildTurns, materializeHistory, runCompaction } from "../src/compaction.js";
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
  expect(outcome).not.toHaveProperty("summaryDiscarded");
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
});

test("a reachable fitting fold can increase the request tokens", async () => {
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
  expect(outcome.status).toBe("rewritten");
  if (outcome.status !== "rewritten") throw new Error(JSON.stringify(outcome));
  expect(outcome.fill.inputTokens).toBe(foldedTokens);
  expect(inputTokens(messages(log))).toBeGreaterThan(beforeTokens);
  expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(1);
});
