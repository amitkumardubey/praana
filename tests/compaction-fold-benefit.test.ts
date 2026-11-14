import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalWriter } from "../src/canonical-transcript.js";
import * as compaction from "../src/compaction.js";
import type { SummaryResult } from "../src/compaction-requests.js";
import { EventLog } from "../src/event-log.js";
import { appendCommit, minimumValidSummary, readCommits, restoreFrozenStateFromLog, SUMMARY_HEADINGS, type FrozenState } from "../src/frozen-summary.js";

const fixtures: { log: EventLog; root: string }[] = [];
afterEach(() => {
  mock.restore();
  for (const { log, root } of fixtures.splice(0)) {
    log.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "compaction-benefit-"));
  const log = new EventLog("benefit", root);
  fixtures.push({ log, root });
  return { log, writer: new CanonicalWriter(log, (error) => { throw error; }) };
}

function summary(body: string): string {
  return SUMMARY_HEADINGS.map((heading, i) => `### ${heading}${i === 0 ? `\n${body}` : ""}`).join("\n\n");
}

function response(text: string): SummaryResult {
  return { text, finishReason: "stop", toolCalls: [], usage: null };
}

function restored(log: EventLog): FrozenState {
  const result = restoreFrozenStateFromLog(log);
  if (!result.ok) throw result.error;
  return result.state;
}

function tokens(log: EventLog, state: FrozenState): number {
  const result = compaction.materializeHistory(state, log);
  if (!result.ok) throw result.error;
  return compaction.estimateRequestTokens({}, result.messages);
}

const liveRequest = { model: "test", provider: "anthropic" as const, messages: [{ role: "user" as const, content: "Summarize the conversation." }] };

async function seedSummary(log: EventLog, writer: CanonicalWriter, text: string) {
  const seed = await writer.startTurn("Earlier work");
  await writer.assistant(seed, { role: "assistant", content: "done" });
  const boundaryEventId = log.readAll({ includeInternal: true }).at(-1)!.event_id;
  expect(appendCommit(log, {
    formatVersion: 1, resetEpoch: "session_start", generation: 1,
    boundaryEventId, summary: text, stubSet: [],
    summaryRequest: { cutDescription: "earlier work", capTokens: 4096, instructionSha256: "a".repeat(64), usage: null },
  })).toEqual({ status: "committed" });
}

for (const largePrevious of [true, false]) {
  test(`benefit pre-check includes a ${largePrevious ? "large" : "minimum-sized"} previous summary`, async () => {
    const { log, writer } = fixture();
    await seedSummary(log, writer, largePrevious ? summary("P".repeat(2400)) : minimumValidSummary());
    const completed = await writer.startTurn("");
    await writer.assistant(completed, { role: "assistant", content: "" });
    const cut = log.readAll({ includeInternal: true }).at(-1)!.event_id;
    await writer.startTurn("Current request");
    const before = restored(log);
    const text = largePrevious ? minimumValidSummary() : summary("S".repeat(2400));
    let calls = 0;
    const outcome = await compaction.runCompaction({
      log, liveRequest, contextWindowTokens: 6000,
      options: { effectiveMaxTokens: 200, tailTurns: 0, contextLimitRatio: 0.001, postRewriteMargin: 0 },
      runSummary: async () => { calls++; return response(text); },
    });
    // Even a minimum previous summary can be replaced while removing a completed turn.
    expect(tokens(log, { ...before, boundaryEventId: cut, summary: minimumValidSummary() })).toBeLessThan(tokens(log, before));
    expect(calls).toBe(1);
    if (largePrevious) {
      expect(outcome.status).toBe("rewritten");
      expect(restored(log)).toMatchObject({ generation: 2, boundaryEventId: cut, summary: text });
      expect(tokens(log, restored(log))).toBeLessThan(tokens(log, before));
      expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(2);
    } else {
      expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_not_beneficial", summaryDiscarded: true });
      expect(restored(log)).toEqual(before);
      expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(1);
    }
  });
}

for (const scenario of [
  { name: "non-beneficial fitting", oldChars: 900, currentChars: 40, summaryChars: 2400, beneficial: false, foldFits: true },
  { name: "non-beneficial oversized", oldChars: 900, currentChars: 21000, summaryChars: 2400, beneficial: false, foldFits: false },
  { name: "beneficial oversized", oldChars: 3000, currentChars: 22400, summaryChars: 2400, beneficial: true, foldFits: false },
]) {
  test(`fold decision and discard outcome agree for a ${scenario.name} request`, async () => {
    const { log, writer } = fixture();
    const old = await writer.startTurn("C".repeat(scenario.oldChars));
    await writer.assistant(old, { role: "assistant", content: "done" });
    await writer.startTurn("U".repeat(scenario.currentChars));
    const before = restored(log);
    const text = summary("S".repeat(scenario.summaryChars));
    let calls = 0;
    let baselineKeys = 0;
    const stringify = JSON.stringify;
    const keySpy = spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
      const value = args[0];
      if (Array.isArray(value) && value.length === 4 && value[0] === before.resetEpoch && value[1] === null && value[2] === null && Array.isArray(value[3])) baselineKeys++;
      return stringify(...args);
    });
    const outcome = await compaction.runCompaction({
      log, liveRequest, contextWindowTokens: 6000,
      options: { effectiveMaxTokens: 200, tailTurns: 0, contextLimitRatio: 0.01, postRewriteMargin: 0 },
      runSummary: async () => { calls++; return response(text); },
    });
    keySpy.mockRestore();
    expect(calls).toBe(1);
    const discarded = "discardedSummary" in outcome ? outcome.discardedSummary : undefined;
    expect(discarded?.text).toBe(text);
    const folded = { ...before, boundaryEventId: discarded!.boundaryEventId, summary: text };
    expect(tokens(log, folded) < tokens(log, before)).toBe(scenario.beneficial);
    expect(tokens(log, folded) <= 5800).toBe(scenario.foldFits);
    if (scenario.beneficial) {
      expect(outcome.status).toBe("capacity_error");
    } else {
      expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "fold_not_beneficial" });
    }
    expect(restored(log)).toEqual(before);
    expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
    // Two seed keys, one pre-fold lookup and one unfolded fallback lookup.
    expect(baselineKeys).toBe(4);
  });
}
