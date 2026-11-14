import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as requestsApi from "../src/compaction-requests.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CanonicalWriter } from "../src/canonical-transcript.js";
import * as compaction from "../src/compaction.js";
import { EventLog } from "../src/event-log.js";
import { cutDescription, planBatchSummaries } from "../src/compaction-requests.js";
import { appendCommit, buildSummaryInstruction, minimumValidSummary, renderSummaryMessage, restoreFrozenState, restoreFrozenStateFromLog, summaryCapTokens } from "../src/frozen-summary.js";
import type { StreamRequest } from "../src/llm/types.js";

const fixtures: { log: EventLog; root: string }[] = [];
afterEach(() => {
  mock.restore();
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

test("runtime replay failures return typed outcomes while static options still throw", async () => {
  const { log, writer } = fixture();
  const turn = await writer.startTurn("pending");
  await writer.assistant(turn, { role: "assistant", content: "", toolCalls: [
    { id: "one", name: "shell", args: {} }, { id: "two", name: "shell", args: {} },
  ] });
  await writer.result(turn, "one", "shell", "done", false);
  const pending = await compaction.runCompaction({ log, liveRequest: live, contextWindowTokens: 12000, options });
  expect(pending.status).toBe("pending_batch");
  if (pending.status === "pending_batch") expect(pending.error.code).toBe("pending_batch");
  await expect(compaction.runCompaction({ log, liveRequest: live, contextWindowTokens: 12000,
    options: { ...options, contextLimitRatio: 0 },
  })).rejects.toBeInstanceOf(RangeError);

  const valid = fixture();
  await seed(valid.log, valid.writer);
  const corrupt = { readAll: () => valid.log.readAll({ includeInternal: true }).map(event => event.kind === "compaction_commit"
    ? { ...event, payload: { ...event.payload, generation: 42 } } : event), append: valid.log.append.bind(valid.log) };
  const invalid = await compaction.runCompaction({ log: corrupt, liveRequest: live, contextWindowTokens: 12000, options });
  expect(invalid.status).toBe("invalid_state");
  if (invalid.status === "invalid_state") expect(invalid.error.name).toBe("FrozenSummaryError");
});

test("failed candidate materialization returns invalid_state", async () => {
  const { log, writer } = fixture();
  const old = await writer.startTurn("old " + "x".repeat(1000));
  await writer.assistant(old, { role: "assistant", content: "done" });
  await writer.startTurn("current");
  let calls = 0;
  const outcome = await compaction.runCompaction({ log, liveRequest: live, contextWindowTokens: 12000, options,
    runSummary: async () => response(),
    materialize: (frozen, source) => ++calls === 1 ? compaction.materializeHistory(frozen, source)
      : { ok: false, error: new compaction.MaterializationError("invalid_state", "bad candidate") },
  });
  expect(calls).toBeGreaterThan(1);
  expect(outcome.status).toBe("invalid_state");
});

for (const batch of [false, true]) test(`previous summary is sent once with batch=${batch}`, async () => {
  const { log, writer } = fixture();
  const previous = minimumValidSummary().replace("\nok", "\nPREVIOUS-" + "p".repeat(1200));
  await seed(log, writer, previous);
  const turn = await writer.startTurn("folded " + "x".repeat(4000));
  await writer.assistant(turn, { role: "assistant", content: "done" });
  await writer.startTurn("retained");
  const mat = compaction.materializeHistory(state(log), log);
  if (!mat.ok) throw mat.error;
  // A window that admits the native prefix and one instruction, not two summaries.
  const window = 2000;
  const instruction = buildSummaryInstruction({ cutDescription: cutDescription(1, compaction.buildTurns(log).at(-1)),
    capTokens: summaryCapTokens(window - 200) });
  const single = compaction.estimateRequestTokens({}, [...mat.messages, { role: "user", content: instruction }]);
  expect(single + 200).toBeLessThan(window);
  expect(single + compaction.estimateMessageTokens(renderSummaryMessage(previous)) + 200).toBeGreaterThan(window);
  const requests: StreamRequest[] = [];
  const outcome = await compaction.runCompaction({ log,
    liveRequest: batch ? { ...live, messages: [{ role: "user", content: "force batch ".repeat(3000) }] } : live,
    contextWindowTokens: window, options,
    runSummary: async request => { requests.push(request); return response(); },
  });
  expect(outcome.status).toBe("rewritten");
  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(JSON.stringify(request.messages).split("PREVIOUS-")).toHaveLength(2);
  const last = request.messages.at(-1)!;
  if (last.role === "tool_result" || typeof last.content !== "string") throw new Error("Expected instruction");
  if (batch) expect(last.content).toContain(previous);
  else {
    expect(request.messages[0]).toEqual(renderSummaryMessage(previous));
    expect(last.content).not.toContain(previous);
    expect(last.content).toContain("previous summary is the first message above");
    expect(JSON.stringify(request.messages)).not.toContain("no retained tail");
  }
});

test("batch metadata hashes all three primary instructions in order", async () => {
  const hashes: string[] = [];
  for (const changed of [-1, 0, 1, 2]) {
    const { log, writer } = fixture();
    for (const size of [13000, 2000, 2000]) {
      const turn = await writer.startTurn("x".repeat(size));
      await writer.assistant(turn, { role: "assistant", content: "done" });
    }
    await writer.startTurn("retained");
    const original = requestsApi.nextBatchSummaryRequest;
    const spy = spyOn(requestsApi, "nextBatchSummaryRequest").mockImplementation((...args) => {
      const step = original(...args);
      if (step.status === "request" && step.attempt === 0 && step.batchIndex === changed) {
        const last = step.request.messages.at(-1)!;
        if (last.role === "tool_result" || typeof last.content !== "string") throw new Error("Expected instruction");
        step.request.messages[step.request.messages.length - 1] = { ...last, content: last.content + "\nChanged instruction." };
      }
      return step;
    });
    const instructions: string[] = [];
    const outcome = await compaction.runCompaction({ log, liveRequest: live, contextWindowTokens: 4000, options,
      runSummary: async request => {
        const last = request.messages.at(-1)!;
        if (last.role === "tool_result" || typeof last.content !== "string") throw new Error("Expected instruction");
        instructions.push(last.content);
        return response();
      },
    });
    spy.mockRestore();
    expect(instructions).toHaveLength(3);
    expect(outcome.status).toBe("rewritten");
    if (outcome.status !== "rewritten") throw new Error(outcome.status);
    const hash = outcome.state.summaryRequest!.instructionSha256;
    const expected = createHash("sha256").update(instructions.map(text => createHash("sha256").update(text).digest("hex")).join("\n")).digest("hex");
    expect(hash).toBe(expected);
    hashes.push(hash);
  }
  expect(new Set(hashes).size).toBe(4);
});

for (const reasoning of [false, true]) test(`native estimates count visible blocks once with reasoning=${reasoning}`, async () => {
  const { log, writer } = fixture();
  const turn = await writer.startTurn("inspect");
  const text = "visible text ".repeat(200);
  const thinking = "visible reasoning ".repeat(200);
  const args = { command: "echo ".repeat(300) };
  await writer.assistant(turn, { role: "assistant", content: text, toolCalls: [{ id: "call", name: "shell", args }],
    ...(reasoning ? { thinking, thinkingSignature: "opaque".repeat(3000) } : {}),
    blocks: [
      ...(reasoning ? [{ type: "thinking" as const, thinking, signature: "opaque".repeat(3000) }] : []),
      { type: "text", text }, { type: "tool_use", id: "call" },
    ],
  });
  await writer.result(turn, "call", "shell", "done", false);
  const message = compaction.buildTurns(log)[0].messages[1];
  if (message.role !== "assistant") throw new Error("Expected assistant");
  const before = JSON.stringify(message);
  const estimate = compaction.estimateMessageTokens(message);
  expect(estimate).toBeLessThan(Math.ceil(before.length / 4));
  expect(estimate).toBeGreaterThanOrEqual(Math.ceil((text.length + JSON.stringify(args).length + (reasoning ? thinking.length : 0)) / 4));
  const noSignatures = { ...message, thinkingSignature: "", blocks: message.blocks!.map(block => block.type === "thinking" ? { ...block, signature: "" } : block) };
  expect(compaction.estimateMessageTokens(noSignatures)).toBe(estimate);
  expect(compaction.estimateMessageTokens({ ...message, content: text.repeat(3) })).toBe(estimate);
  const argsChanged = { ...message, toolCalls: message.toolCalls!.map(call => ({ ...call, args: { command: args.command.repeat(2) } })) };
  expect(compaction.estimateMessageTokens(argsChanged)).toBeGreaterThan(estimate);
  expect(JSON.stringify(message)).toBe(before);
  if (reasoning) {
    const { blocks: _blocks, ...legacy } = message;
    expect(compaction.estimateMessageTokens({ ...legacy, thinkingSignature: "" })).toBe(compaction.estimateMessageTokens(legacy));
  }
});

test("rendered summary allowance handles a newline-heavy summary at the cap", async () => {
  const { log, writer } = fixture();
  for (const size of [5000, ...Array(8).fill(1000)]) {
    const turn = await writer.startTurn("x".repeat(size));
    await writer.assistant(turn, { role: "assistant", content: "done" });
  }
  await writer.startTurn("current " + "y".repeat(1000));
  const cap = summaryCapTokens(2800);
  const summary = minimumValidSummary() + "\n".repeat(cap * 4 - minimumValidSummary().length);
  expect(Math.ceil(summary.length / 4)).toBe(cap);
  let calls = 0;
  const outcome = await compaction.runCompaction({ log, liveRequest: live, contextWindowTokens: 3000,
    options: { ...options, tailTurns: 8, contextLimitRatio: 1 },
    runSummary: async () => { calls++; return response(summary); },
  });
  expect(calls).toBeGreaterThan(0);
  expect(outcome.status).toBe("rewritten");
  if (outcome.status !== "rewritten") throw new Error(outcome.status);
  expect(outcome.fill.fits).toBe(true);
  expect(outcome).not.toHaveProperty("discardedSummary");
});

test("summary failure discards computed stale stubs when the unmodified request fits", async () => {
  const { log, writer } = fixture();
  const turn = await writer.startTurn("old " + "x".repeat(1000));
  await writer.assistant(turn, { role: "assistant", content: "", toolCalls: [{ id: "call", name: "shell", args: {} }] });
  await writer.result(turn, "call", "shell", "r".repeat(2000), false);
  await writer.startTurn("current");
  const before = log.readAll({ includeInternal: true });
  let stalePlans = 0;
  let summaryCalls = 0;
  const outcome = await compaction.runCompaction({ log, liveRequest: live, contextWindowTokens: 12000, options,
    planStubs: (candidates, phase) => {
      if (phase.phase === "stale") stalePlans++;
      return candidates.map(candidate => ({ eventId: candidate.eventId, stubText: "stub" }));
    },
    runSummary: async () => { summaryCalls++; throw new Error("unavailable"); },
  });
  expect(stalePlans).toBe(1);
  expect(summaryCalls).toBe(1);
  expect(outcome.status).toBe("summary_failed_fits");
  expect(log.readAll({ includeInternal: true })).toEqual(before);
  expect(state(log).stubSet).toEqual([]);
});

test("commits reject stubs at or before the folded boundary on append and restore", async () => {
  const { log, writer } = fixture();
  const old = await writer.startTurn("old");
  const ids: string[] = [];
  for (const id of ["before", "boundary"]) {
    await writer.assistant(old, { role: "assistant", content: "", toolCalls: [{ id, name: "shell", args: {} }] });
    await writer.result(old, id, "shell", "result", false);
    ids.push(log.readAll({ includeInternal: true }).at(-1)!.event_id);
  }
  const tail = await writer.startTurn("retained");
  await writer.assistant(tail, { role: "assistant", content: "", toolCalls: [{ id: "tail", name: "shell", args: {} }] });
  await writer.result(tail, "tail", "shell", "retained result", false);
  const tailId = log.readAll({ includeInternal: true }).at(-1)!.event_id;
  const commit = { formatVersion: 1 as const, ...state(log), generation: 1, boundaryEventId: ids[1], summary: minimumValidSummary(),
    summaryRequest: { cutDescription: "old", capTokens: 100, instructionSha256: "a".repeat(64), usage: null },
    stubSet: [{ eventId: tailId, stubText: "stub" }],
  };
  const before = log.readAll({ includeInternal: true });
  for (const eventId of ids) {
    expect(appendCommit(log, { ...commit, stubSet: [{ eventId, stubText: "stub" }] })).toMatchObject({ status: "rejected", error: { code: "invalid_commit" } });
    expect(log.readAll({ includeInternal: true })).toEqual(before);
  }
  expect(appendCommit(log, commit).status).toBe("committed");
  for (const eventId of ids) {
    const events = log.readAll({ includeInternal: true }).map(event => event.kind === "compaction_commit"
      ? { ...event, payload: { ...event.payload, stubSet: [{ eventId, stubText: "stub" }] } } : event);
    expect(restoreFrozenState(events)).toMatchObject({ ok: false, error: { code: "invalid_commit" } });
  }
});

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
