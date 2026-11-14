import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalWriter } from "../src/canonical-transcript.js";
import * as compaction from "../src/compaction.js";
import type { SummaryResult } from "../src/compaction-requests.js";
import { EventLog } from "../src/event-log.js";
import { readCommits, restoreFrozenStateFromLog, SUMMARY_HEADINGS, type FrozenState } from "../src/frozen-summary.js";

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
