import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CanonicalWriter } from "../src/canonical-transcript.js";
import * as compaction from "../src/compaction.js";
import { EventLog } from "../src/event-log.js";
import { cutDescription, planBatchSummaries } from "../src/compaction-requests.js";
import { appendCommit, minimumValidSummary, restoreFrozenStateFromLog } from "../src/frozen-summary.js";
import type { StreamRequest } from "../src/llm/types.js";

const fixtures: { log: EventLog; root: string }[] = [];
afterEach(() => {
  for (const { log, root } of fixtures.splice(0)) { log.close(); rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const root = mkdtempSync(join("/home/amit/.cache/compfollow", "fixture-"));
  const log = new EventLog("followups", root);
  fixtures.push({ log, root });
  return { log, writer: new CanonicalWriter(log, error => { throw error; }) };
}
function state(log: EventLog) {
  const result = restoreFrozenStateFromLog(log);
  if (!result.ok) throw result.error;
  return result.state;
}
const live: StreamRequest = { model: "test", provider: "anthropic", messages: [] };
const options = { effectiveMaxTokens: 200, tailTurns: 0, contextLimitRatio: 0.01, postRewriteMargin: 0 };
test("cut collapses newlines and batch cut covers only folded user turns", async () => {
  const { log, writer } = fixture();
  const turn = await writer.startTurn("shared first");
  await writer.assistant(turn, { role: "assistant", content: "done" });
  await writer.startTurn('shared retained\n\r\n"quoted"');
  const turns = compaction.buildTurns(log);
  expect(cutDescription(1, turns[1])).toContain(`beginning ${JSON.stringify('shared retained "quoted"')}`);
  const plan = planBatchSummaries(live, [turns[0]], { capTokens: 100, contextWindowTokens: 12000, effectiveMaxTokens: 200 });
  expect(plan.status).toBe("planned");
  if (plan.status !== "planned") throw new Error(plan.status);
  expect(plan.plan.batches[0].cutDescription).toBe("1 folded user turns; summarize every message below");
});
const response = (text = minimumValidSummary()) => ({ text, finishReason: "stop" as const, toolCalls: [], usage: null });
async function seed(log: EventLog, writer: CanonicalWriter, text = minimumValidSummary()) {
  const turn = await writer.startTurn("earlier");
  await writer.assistant(turn, { role: "assistant", content: "done" });
  expect(appendCommit(log, { formatVersion: 1, ...state(log), generation: 1,
    boundaryEventId: log.readAll({ includeInternal: true }).at(-1)!.event_id, summary: text,
    summaryRequest: { cutDescription: "earlier", capTokens: 4096, instructionSha256: "a".repeat(64), usage: null },
  }).status).toBe("committed");
}

for (const length of [80, 200]) for (const previous of [false, true]) {
  test(`visible cut quotes ${length} characters with previous=${previous}`, async () => {
    const { log, writer } = fixture();
    if (previous) await seed(log, writer);
    for (const suffix of ["one", "two", "three"]) {
      const turn = await writer.startTurn(`shared prefix ${suffix}`);
      await writer.assistant(turn, { role: "assistant", content: "x".repeat(800) });
    }
    const retained = 'shared prefix retained "quote" ' + "z".repeat(length - 31);
    // Keep the exact requested length, including embedded quotes.
    const text = (retained + "z".repeat(length)).slice(0, length);
    await writer.startTurn(text);
    let request: StreamRequest | undefined;
    await compaction.runCompaction({ log, liveRequest: live, contextWindowTokens: 12000, options,
      runSummary: async req => { request = req; return response(); },
    });
    expect(request).toBeDefined();
    const instruction = String((request!.messages.at(-1) as { content: string }).content);
    const quote = JSON.stringify(text.slice(0, 80));
    expect(instruction).toContain("3 folded user turns");
    expect(instruction).toContain(`beginning ${quote}`);
    expect(request!.messages.slice(0, -1).filter(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith(text.slice(0, 80)))).toHaveLength(1);
    expect(request!.messages.slice(0, -1).filter(message => message.role === "user")).toHaveLength(previous ? 5 : 4);
    expect(instruction).not.toContain("canonical event");
  });
}
