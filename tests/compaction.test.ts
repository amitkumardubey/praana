import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalWriter, type CanonicalRecord } from "../src/canonical-transcript.js";
import {
  buildSameModelSummaryRequest,
  buildSummaryRepairRequest,
  nextBatchSummaryRequest,
  planBatchSummaries,
  type BatchSummaryAttempt,
  type SummaryResult,
} from "../src/compaction-requests.js";
import { EventLog, type EventLogOptions } from "../src/event-log.js";
import {
  buildSummaryInstruction,
  checkSummary,
  readCommits,
  restoreFrozenStateFromLog,
  SUMMARY_HEADINGS,
  type FrozenState,
} from "../src/frozen-summary.js";
import type { ConversationMessage, StreamRequest } from "../src/llm/types.js";
import { StateGraph } from "../src/state-graph.js";
import { estimateTokens } from "../src/token-estimate.js";
import * as compaction from "../src/compaction.js";
import type { Event } from "../src/types.js";

const api = async () => compaction;

const roots: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  mock.restore();
  for (const log of logs.splice(0)) log.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openLog(options: EventLogOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "compaction-run-d-"));
  roots.push(root);
  const log = new EventLog("s", root, options);
  logs.push(log);
  return { root, log };
}

function appendRecord(log: EventLog, id: string, record: CanonicalRecord): { event_id: string } {
  log.append({ event_id: id, kind: "canonical_message", actor: "kernel", payload: { ...record } });
  return { event_id: id };
}

function addTurn(
  log: EventLog,
  turnId: number,
  options: {
    prefix?: string;
    inputText?: string;
    assistantText?: string;
    toolResults?: { id?: string; callId?: string; toolName?: string; text: string; isError?: boolean }[];
  } = {},
): string[] {
  const prefix = options.prefix ?? `t${turnId}`;
  const ids: string[] = [];
  ids.push(appendRecord(log, `${prefix}-in`, {
    formatVersion: 1,
    kind: "user_input",
    turnId,
    message: { text: options.inputText ?? `User request ${turnId}` },
  }).event_id);
  const results = options.toolResults ?? [];
  if (results.length > 0) {
    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      const callId = item.callId ?? `${prefix}-call-${i + 1}`;
      const resultId = item.id ?? `${prefix}-res-${i + 1}`;
      ids.push(appendRecord(log, `${prefix}-asst-${i + 1}`, {
        formatVersion: 1,
        kind: "assistant",
        turnId,
        message: {
          text: `Running tool ${i + 1}`,
          toolCalls: [{ id: callId, name: item.toolName ?? "shell", args: { step: i + 1 } }],
        },
      }).event_id);
      ids.push(appendRecord(log, resultId, {
        formatVersion: 1,
        kind: "tool_result",
        turnId,
        message: {
          callId,
          toolName: item.toolName ?? "shell",
          text: item.text,
          isError: item.isError ?? false,
        },
      }).event_id);
    }
  }
  if (options.assistantText !== undefined || results.length === 0) {
    ids.push(appendRecord(log, `${prefix}-final`, {
      formatVersion: 1,
      kind: "assistant",
      turnId,
      message: { text: options.assistantText ?? `Completed turn ${turnId}` },
    }).event_id);
  }
  return ids;
}

function addReset(log: EventLog, id = "clear-1"): void {
  log.append({ event_id: id, kind: "system_note", actor: "kernel", payload: { type: "reset_boundary", command: "/clear" } });
}

function validSummary(active = "Continue executing the task.", extra = ""): string {
  return SUMMARY_HEADINGS.map((heading, index) => {
    if (index === 0) return `### ${heading}\n${active}`;
    if (heading === "Completed" && extra) return `### ${heading}\n- ${extra}`;
    return `### ${heading}\n- item`;
  }).join("\n\n");
}

function summaryResp(text = validSummary(), overrides: Partial<SummaryResult> = {}): SummaryResult {
  return {
    text,
    finishReason: "stop",
    usage: { input: 100, output: 40, totalTokens: 140, cacheReadTokens: 80, cacheWriteTokens: 0 },
    toolCalls: [],
    ...overrides,
  };
}

function baseLiveRequest(messages: ConversationMessage[] = []): StreamRequest {
  return {
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
    messages,
  };
}

// Independent token accounting oracle (does not call estimateRequestTokens or requestFill).
function oracleObjectSort(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Array.isArray(value) ? value.map(oracleObjectSort) : value;
  }
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, oracleObjectSort((value as Record<string, unknown>)[k])]),
  );
}

function oracleInputTokens(
  frame: { systemPrompt?: string; snapshot?: string; tools?: readonly unknown[] },
  messages: readonly ConversationMessage[],
): number {
  const frameTokens = estimateTokens(JSON.stringify(oracleObjectSort({
    systemPrompt: frame.systemPrompt,
    snapshot: frame.snapshot,
    tools: frame.tools,
  })));
  const msgTokens = messages.reduce((sum, msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      let images = 0;
      const stripped = msg.content.map((p) => {
        if (p.type !== "image") return p;
        images += 1600;
        const { data: _d, ...rest } = p;
        return rest;
      });
      return sum + images + estimateTokens(JSON.stringify(oracleObjectSort({ ...msg, content: stripped })));
    }
    return sum + estimateTokens(JSON.stringify(oracleObjectSort(msg)));
  }, 0);
  return frameTokens + msgTokens;
}

test("ladder stops at step 1 when stubbing stale tool results older than the tail reaches the target", async () => {
  const { runCompaction, materializeHistory } = await api();
  const { log } = openLog();
  // 2 stale turns with large tool results + 4 tail completed turns + 1 in-flight turn.
  addTurn(log, 1, { toolResults: [{ id: "stale-1", text: "S1:".repeat(1200) }] });
  addTurn(log, 2, { toolResults: [{ id: "stale-2", text: "S2:".repeat(1200) }] });
  for (let t = 3; t <= 6; t++) {
    addTurn(log, t, { toolResults: [{ id: `tail-${t}`, text: "T".repeat(1000) }] });
  }
  addTurn(log, 7, { toolResults: [{ id: "inflight-7", text: "I".repeat(1000) }] });

  let summaryCalls = 0;
  const stubbedIds: string[] = [];
  const outcome = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 3400,
    options: { effectiveMaxTokens: 200, tailTurns: 4, stubMinTokens: 100 },
    planStubs: (candidates) => {
      stubbedIds.push(...candidates.map((c) => c.eventId));
      return candidates.map((c) => ({ eventId: c.eventId, stubText: `[stub:${c.eventId}]` }));
    },
    runSummary: async () => {
      summaryCalls++;
      return summaryResp();
    },
  });

  expect(outcome.status).toBe("stubbed");
  if (outcome.status !== "stubbed") throw new Error(JSON.stringify(outcome));
  expect(summaryCalls).toBe(0);
  expect(stubbedIds).toEqual(["stale-1", "stale-2"]);
  expect(outcome.state.generation).toBe(1);
  expect(outcome.state.summary).toBeNull();
  expect(outcome.state.boundaryEventId).toBeNull();
  expect(outcome.state.summaryRequest).toBeNull();
  expect(outcome.state.stubSet).toEqual([
    { eventId: "stale-1", stubText: "[stub:stale-1]" },
    { eventId: "stale-2", stubText: "[stub:stale-2]" },
  ]);
  expect(outcome.fill.ratio).toBeLessThanOrEqual(0.65);
  const mat = materializeHistory(outcome.state, log);
  expect(mat.ok).toBe(true);
  if (!mat.ok) throw mat.error;
  const serialized = JSON.stringify(mat.messages);
  expect(serialized).toContain("[stub:stale-1]");
  expect(serialized).toContain("[stub:stale-2]");
  // Tail and in-flight tool results are untouched.
  expect(serialized).toContain("T".repeat(1000));
  expect(serialized).toContain("I".repeat(1000));
});

test("ladder stops at step 2 with full tailTurns=4 when folding older turns reaches the target and drops folded stubs", async () => {
  const { runCompaction, materializeHistory } = await api();
  const { log } = openLog();
  // First create 6 turns and a prior stubs-only commit on turn 1 so we verify folded stubs are dropped.
  addTurn(log, 1, { inputText: "Turn1 ".repeat(700), toolResults: [{ id: "old-stub-1", text: "O".repeat(1200) }] });
  addTurn(log, 2, { inputText: "Turn2 ".repeat(700) });
  for (let t = 3; t <= 6; t++) {
    addTurn(log, t, { inputText: `TailTurn${t} `.repeat(40), toolResults: [{ id: `tail-keep-${t}`, text: "K".repeat(400) }] });
  }
  addTurn(log, 7, { inputText: "InFlight 7" });

  // Pre-seed a generation-1 stub on old-stub-1 (inside turn 1, which will be folded) and tail-keep-3 (inside turn 3, which stays in the 4-turn tail).
  const { appendCommit } = await import("../src/frozen-summary.js");
  expect(appendCommit(log, {
    formatVersion: 1,
    resetEpoch: "session_start",
    generation: 1,
    boundaryEventId: null,
    summary: null,
    stubSet: [
      { eventId: "old-stub-1", stubText: "[prior-folded-stub]" },
      { eventId: "tail-keep-3", stubText: "[retained-tail-stub]" },
    ],
    summaryRequest: null,
  })).toEqual({ status: "committed" });

  const summaryRequests: StreamRequest[] = [];
  const outcome = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 3200,
    options: { effectiveMaxTokens: 200, tailTurns: 4, stubMinTokens: 500 },
    runSummary: async (req) => {
      summaryRequests.push(req);
      return summaryResp(validSummary("Folded turns 1 and 2."));
    },
  });

  expect(outcome.status).toBe("rewritten");
  if (outcome.status !== "rewritten") throw new Error(JSON.stringify(outcome));
  expect(summaryRequests).toHaveLength(1);
  // Boundary is the end of turn 2 (turns 3, 4, 5, 6 are the 4 completed turns in the tail, turn 7 is in-flight).
  expect(outcome.state.boundaryEventId).toBe("t2-final");
  expect(outcome.state.generation).toBe(2);
  expect(outcome.state.summary).toContain("Folded turns 1 and 2.");
  // Stub pointing into folded turn 1 (old-stub-1) MUST be dropped; stub in retained tail turn 3 is kept.
  expect(outcome.state.stubSet).toEqual([{ eventId: "tail-keep-3", stubText: "[retained-tail-stub]" }]);
  const mat = materializeHistory(outcome.state, log);
  expect(mat.ok).toBe(true);
  if (!mat.ok) throw mat.error;
  const text = JSON.stringify(mat.messages);
  expect(text).toContain("Folded turns 1 and 2.");
  expect(text).not.toContain("Turn1 ");
  expect(text).not.toContain("Turn2 ");
  for (let t = 3; t <= 6; t++) expect(text).toContain(`TailTurn${t}`);
  expect(text).toContain("InFlight 7");
});

test("step 2 shrinks the completed-turn tail one turn at a time until frame + summary allowance + tail fits the target", async () => {
  const { runCompaction } = await api();
  for (const [postRewriteMargin, expectedBoundary] of [
    [0.10, "t2-final"], // keeps 4 completed turns (turns 3..6)
    [0.15, "t3-final"], // shrinks to 3 completed turns (turns 4..6)
    [0.30, "t4-final"], // shrinks to 2 completed turns (turns 5..6)
    [0.45, "t5-final"], // shrinks to 1 completed turn (turn 6)
    [0.60, "t6-final"], // shrinks to 0 completed turns (only in-flight turn 7 kept)
  ] as const) {
    const { log } = openLog();
    for (let t = 1; t <= 6; t++) {
      addTurn(log, t, { inputText: `Turn-${t} ` + "x".repeat(1500) });
    }
    addTurn(log, 7, { inputText: "In-flight turn 7" });

    let calls = 0;
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 3100,
      options: { effectiveMaxTokens: 200, tailTurns: 4, postRewriteMargin },
      runSummary: async () => {
        calls++;
        return summaryResp(validSummary(`Cut at ${expectedBoundary}`));
      },
    });
    expect(outcome.status).toBe("rewritten");
    if (outcome.status !== "rewritten") throw new Error(`Failed for margin ${postRewriteMargin}: ${JSON.stringify(outcome)}`);
    expect(calls).toBe(1);
    expect(outcome.state.boundaryEventId).toBe(expectedBoundary);
    expect(outcome.fill.ratio).toBeLessThanOrEqual(0.80 - postRewriteMargin);
  }
});

test("step 3 stubs inside the in-flight turn after folding completed turns and commits summary + stubs in one event", async () => {
  const { runCompaction, materializeHistory } = await api();
  const { log } = openLog();
  addTurn(log, 1, { inputText: "Completed turn 1 " + "a".repeat(1200) });
  addTurn(log, 2, {
    inputText: "In-flight turn 2",
    toolResults: [
      { id: "if-1", text: "R1:".repeat(700) },
      { id: "if-2", text: "R2:".repeat(700) },
      { id: "if-3", text: "R3:".repeat(100) },
      { id: "if-4", text: "R4:".repeat(100) },
      { id: "if-5", text: "R5:".repeat(100) },
    ],
  });

  const outcome = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 1800,
    options: { effectiveMaxTokens: 200, tailTurns: 4, stubKeepRecent: 3, stubMinTokens: 100 },
    planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: `[stub:${c.eventId}]` })),
    runSummary: async () => summaryResp(validSummary("Folded turn 1.")),
  });

  expect(outcome.status).toBe("rewritten");
  if (outcome.status !== "rewritten") throw new Error(JSON.stringify(outcome));
  expect(outcome.state.generation).toBe(1);
  expect(outcome.state.boundaryEventId).toBe("t1-final");
  expect(outcome.state.stubSet).toEqual([
    { eventId: "if-1", stubText: "[stub:if-1]" },
    { eventId: "if-2", stubText: "[stub:if-2]" },
  ]);
  const commits = readCommits(log.readAll({ includeInternal: true }));
  expect(commits).toHaveLength(1);
  const mat = materializeHistory(outcome.state, log);
  expect(mat.ok).toBe(true);
});

test("no-op below trigger and no retrigger after a rewrite; unchanged_fits does not bump generation", async () => {
  const { runCompaction } = await api();
  const { log } = openLog();
  addTurn(log, 1, { inputText: "Small turn" });

  let calls = 0;
  const noopOutcome = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 4000,
    options: { effectiveMaxTokens: 200 },
    runSummary: async () => {
      calls++;
      return summaryResp();
    },
  });
  expect(noopOutcome.status).toBe("noop");
  expect(calls).toBe(0);
  expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);

  // Triggered (ratio >= 0.80) but only 1 in-flight turn with no stubbable tool results, yet fits usable capacity (ratio <= 1.0).
  const { log: log2 } = openLog();
  addTurn(log2, 1, { inputText: "x".repeat(3600) });
  const unchanged = await runCompaction({
    log: log2,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 1100,
    options: { effectiveMaxTokens: 100 },
    runSummary: async () => {
      calls++;
      return summaryResp();
    },
  });
  expect(unchanged.status).toBe("unchanged_fits");
  if (unchanged.status !== "unchanged_fits") throw new Error(JSON.stringify(unchanged));
  expect(unchanged.state.generation).toBe(0);
  expect(calls).toBe(0);
  expect(readCommits(log2.readAll({ includeInternal: true }))).toHaveLength(0);
});

test("two successful compactions produce cumulative summaries and do not retrigger while below threshold", async () => {
  const { runCompaction } = await api();
  const { log } = openLog();
  addTurn(log, 1, { inputText: "Turn 1 " + "a".repeat(3200) });
  addTurn(log, 2, { inputText: "Turn 2 " + "b".repeat(3200) });
  addTurn(log, 3, { inputText: "Turn 3 small" });

  const instructions: string[] = [];
  const firstSummary = validSummary("First summary of turns 1-2.", "step 1 done");
  const first = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 2200,
    options: { effectiveMaxTokens: 200, tailTurns: 0 },
    runSummary: async (req) => {
      const last = req.messages.at(-1)!;
      instructions.push(last.role !== "tool_result" && typeof last.content === "string" ? last.content : JSON.stringify(last));
      return summaryResp(firstSummary);
    },
  });
  expect(first.status).toBe("rewritten");
  if (first.status !== "rewritten") throw new Error(JSON.stringify(first));
  expect(first.state.generation).toBe(1);
  expect(first.state.boundaryEventId).toBe("t2-final");

  // Immediate re-check does not retrigger.
  const recheck = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 2200,
    options: { effectiveMaxTokens: 200, tailTurns: 0 },
    runSummary: async () => {
      throw new Error("Should not be called");
    },
  });
  expect(recheck.status).toBe("noop");
  if (recheck.status !== "noop") throw new Error(JSON.stringify(recheck));
  expect(recheck.state.generation).toBe(1);

  // Add more turns to trigger a second compaction.
  addTurn(log, 4, { inputText: "Turn 4 " + "c".repeat(3100) });
  addTurn(log, 5, { inputText: "Turn 5 " + "d".repeat(3100) });
  addTurn(log, 6, { inputText: "Turn 6 small" });

  const secondSummary = validSummary("Cumulative summary of turns 1-5.", "steps 1 and 2 done");
  const second = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 2200,
    options: { effectiveMaxTokens: 200, tailTurns: 0 },
    runSummary: async (req) => {
      const last = req.messages.at(-1)!;
      instructions.push(last.role !== "tool_result" && typeof last.content === "string" ? last.content : JSON.stringify(last));
      return summaryResp(secondSummary);
    },
  });
  expect(second.status).toBe("rewritten");
  if (second.status !== "rewritten") throw new Error(JSON.stringify(second));
  expect(second.state.generation).toBe(2);
  expect(second.state.boundaryEventId).toBe("t5-final");
  expect(instructions).toHaveLength(2);
  expect(instructions[1]).toContain("First summary of turns 1-2.");
});

test("/clear starts a new reset epoch, restarts generation at 1, and pre-clear summaries never reappear", async () => {
  const { runCompaction, materializeHistory } = await api();
  const { root, log } = openLog();
  addTurn(log, 1, { inputText: "Pre-clear secret turn " + "p".repeat(6000) });
  addTurn(log, 2, { inputText: "Pre-clear in-flight" });

  const preClearSummary = validSummary("PRE_CLEAR_SUMMARY_TEXT");
  const first = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 2100,
    options: { effectiveMaxTokens: 200, tailTurns: 0 },
    runSummary: async () => summaryResp(preClearSummary),
  });
  expect(first.status).toBe("rewritten");

  addReset(log, "clear-epoch-2");
  addTurn(log, 3, { inputText: "Post-clear turn 3 " + "q".repeat(6000) });
  addTurn(log, 4, { inputText: "Post-clear in-flight" });

  const seenInstructions: string[] = [];
  const postClearSummary = validSummary("POST_CLEAR_SUMMARY_TEXT");
  const second = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 2100,
    options: { effectiveMaxTokens: 200, tailTurns: 0 },
    runSummary: async (req) => {
      seenInstructions.push(JSON.stringify(req.messages));
      return summaryResp(postClearSummary);
    },
  });
  expect(second.status).toBe("rewritten");
  if (second.status !== "rewritten") throw new Error(JSON.stringify(second));
  expect(second.state.resetEpoch).toBe("clear-epoch-2");
  expect(second.state.generation).toBe(1);
  expect(seenInstructions[0]).not.toContain("PRE_CLEAR_SUMMARY_TEXT");

  log.close();
  const reopened = new EventLog("s", root);
  logs.push(reopened);
  const restored = restoreFrozenStateFromLog(reopened);
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw restored.error;
  expect(restored.state.resetEpoch).toBe("clear-epoch-2");
  expect(restored.state.generation).toBe(1);
  expect(restored.state.summary).toBe(postClearSummary);
  const mat = materializeHistory(restored.state, reopened);
  expect(mat.ok).toBe(true);
  if (!mat.ok) throw mat.error;
  const rendered = JSON.stringify(mat.messages);
  expect(rendered).toContain("POST_CLEAR_SUMMARY_TEXT");
  expect(rendered).not.toContain("PRE_CLEAR_SUMMARY_TEXT");
});

test("first-turn overflow: rescues a single turn with a stubs-only commit, keeping K recent results verbatim and zero summary calls", async () => {
  const { runCompaction, materializeHistory } = await api();
  const { log } = openLog();
  // Single turn (turn 1) with 6 tool results overflowing the window.
  addTurn(log, 1, {
    inputText: "First turn with many tool calls",
    toolResults: [
      { id: "r1", text: "OLD1:".repeat(600) },
      { id: "r2", text: "OLD2:".repeat(600) },
      { id: "r3", text: "OLD3:".repeat(600) },
      { id: "r4", text: "RECENT4:".repeat(80) },
      { id: "r5", text: "RECENT5:".repeat(80) },
      { id: "r6", text: "RECENT6:".repeat(80) },
    ],
  });

  let summaryCalls = 0;
  const outcome = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 2000,
    options: { effectiveMaxTokens: 200, stubKeepRecent: 3, stubMinTokens: 100 },
    planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: `[stub:${c.eventId}]` })),
    runSummary: async () => {
      summaryCalls++;
      return summaryResp();
    },
  });

  expect(outcome.status).toBe("stubbed");
  if (outcome.status !== "stubbed") throw new Error(JSON.stringify(outcome));
  expect(summaryCalls).toBe(0);
  expect(outcome.state.generation).toBe(1);
  expect(outcome.state.boundaryEventId).toBeNull();
  expect(outcome.state.summary).toBeNull();
  expect(outcome.state.summaryRequest).toBeNull();
  expect(outcome.state.stubSet.map((s) => s.eventId)).toEqual(["r1", "r2", "r3"]);
  expect(outcome.fill.fits).toBe(true);

  const mat = materializeHistory(outcome.state, log);
  expect(mat.ok).toBe(true);
  if (!mat.ok) throw mat.error;
  const text = JSON.stringify(mat.messages);
  expect(text).toContain("[stub:r1]");
  expect(text).toContain("[stub:r2]");
  expect(text).toContain("[stub:r3]");
  expect(text).toContain("RECENT4:".repeat(80));
  expect(text).toContain("RECENT5:".repeat(80));
  expect(text).toContain("RECENT6:".repeat(80));
});

test("first-turn hard pressure shrinks stubKeepRecent down to 1 and never stubs the newest result", async () => {
  const { runCompaction, materializeHistory } = await api();
  const { log } = openLog();
  addTurn(log, 1, {
    inputText: "Hard pressure turn",
    toolResults: [
      { id: "r1", text: "RES1:".repeat(500) },
      { id: "r2", text: "RES2:".repeat(500) },
      { id: "r3", text: "RES3:".repeat(500) },
      { id: "r4", text: "NEWEST4:".repeat(120) },
    ],
  });

  let summaryCalls = 0;
  const outcome = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 1200,
    options: { effectiveMaxTokens: 200, stubKeepRecent: 3, stubMinTokens: 100 },
    planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: `[stub:${c.eventId}]` })),
    runSummary: async () => {
      summaryCalls++;
      return summaryResp();
    },
  });

  expect(outcome.status).toBe("stubbed");
  if (outcome.status !== "stubbed") throw new Error(JSON.stringify(outcome));
  expect(summaryCalls).toBe(0);
  expect(outcome.state.stubSet.map((s) => s.eventId)).toEqual(["r1", "r2", "r3"]);
  const mat = materializeHistory(outcome.state, log);
  expect(mat.ok).toBe(true);
  if (!mat.ok) throw mat.error;
  expect(JSON.stringify(mat.messages)).toContain("NEWEST4:".repeat(120));
});

test("in-flight stubbing starts at stubKeepRecent and keeps as many recent results as fit", async () => {
  const { runCompaction } = await api();

  // 1. Single in-flight turn with 3 results and stubKeepRecent=3 that already fits usable capacity (0.80 <= ratio <= 1.0)
  // must keep all 3 recent results verbatim instead of starting at keepRecent=2 and stubbing r1.
  {
    const { log } = openLog();
    addTurn(log, 1, {
      inputText: "Single turn fitting within capacity",
      toolResults: [
        { id: "r1", text: "RES1:".repeat(180) },
        { id: "r2", text: "RES2:".repeat(180) },
        { id: "r3", text: "RES3:".repeat(180) },
      ],
    });
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1200,
      options: { effectiveMaxTokens: 200, stubKeepRecent: 3, stubMinTokens: 100 },
      planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: `[stub:${c.eventId}]` })),
    });
    expect(outcome.status).toBe("unchanged_fits");
    if (outcome.status !== "unchanged_fits") throw new Error(JSON.stringify(outcome));
    expect(outcome.state.stubSet).toEqual([]);
  }

  // 2. Post-fold in-flight turn with 3 results and stubKeepRecent=3 that fits usable capacity (ratio > targetRatio but <= 1.0)
  // must keep all 3 recent results verbatim.
  {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Completed turn 1 " + "a".repeat(1600) });
    addTurn(log, 2, {
      inputText: "In-flight turn 2",
      toolResults: [
        { id: "if-1", text: "R1:".repeat(240) },
        { id: "if-2", text: "R2:".repeat(240) },
        { id: "if-3", text: "R3:".repeat(240) },
      ],
    });
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1200,
      options: { effectiveMaxTokens: 200, tailTurns: 0, stubKeepRecent: 3, stubMinTokens: 100 },
      planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: `[stub:${c.eventId}]` })),
      runSummary: async () => summaryResp(validSummary("Folded turn 1.")),
    });
    expect(outcome.status).toBe("rewritten");
    if (outcome.status !== "rewritten") throw new Error(JSON.stringify(outcome));
    expect(outcome.state.stubSet).toEqual([]);
  }

  // 3. When 3 results with stubKeepRecent=4 exceed usable capacity, shrinking keepRecent stubs only the oldest (r1)
  // and keeps the 2 most recent results (r2, r3) once that fits.
  {
    const { log } = openLog();
    addTurn(log, 1, {
      inputText: "Overflowing turn where stubbing oldest 1 suffices",
      toolResults: [
        { id: "r1", text: "OLDEST1:".repeat(400) },
        { id: "r2", text: "RECENT2:".repeat(200) },
        { id: "r3", text: "RECENT3:".repeat(200) },
      ],
    });
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1200,
      options: { effectiveMaxTokens: 200, stubKeepRecent: 4, stubMinTokens: 100 },
      planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: `[stub:${c.eventId}]` })),
    });
    expect(outcome.status).toBe("stubbed");
    if (outcome.status !== "stubbed") throw new Error(JSON.stringify(outcome));
    expect(outcome.state.stubSet).toEqual([{ eventId: "r1", stubText: "[stub:r1]" }]);
  }
});

test("batch fallback chains multiple batches, repairs once, and commits all-or-nothing without admitting oversized requests", async () => {
  const { runCompaction } = await api();
  const { log } = openLog();
  for (let t = 1; t <= 6; t++) {
    addTurn(log, t, { inputText: `BatchTurn-${t} ` + "b".repeat(2200) });
  }
  addTurn(log, 7, { inputText: "In-flight turn 7" });

  // Live request has systemPrompt/tools so same-model summary does not fit, forcing batch fallback.
  const live: StreamRequest = {
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
    systemPrompt: "SYS ".repeat(400),
    tools: [{ name: "read", description: "DESC ".repeat(300), parameters: { type: "object" } }],
    messages: [],
  };
  const windowTokens = 3800;
  const effectiveMaxTokens = 300;
  const seenRequests: StreamRequest[] = [];
  let callIndex = 0;

  const outcome = await runCompaction({
    log,
    liveRequest: live,
    contextWindowTokens: windowTokens,
    options: { effectiveMaxTokens, tailTurns: 0 },
    runSummary: async (req) => {
      seenRequests.push(req);
      // Independent accounting oracle verifies every request sent is within capacity.
      const inputTok = oracleInputTokens({ systemPrompt: req.systemPrompt, tools: req.tools }, req.messages);
      expect(inputTok + effectiveMaxTokens).toBeLessThanOrEqual(windowTokens);
      callIndex++;
      // Fail the first attempt of batch 1 so it exercises the one-repair path.
      if (callIndex === 2) return summaryResp("invalid markdown without headings");
      return summaryResp(validSummary(`Batch summary call ${callIndex}`));
    },
  });

  expect(outcome.status).toBe("rewritten");
  if (outcome.status !== "rewritten") throw new Error(JSON.stringify(outcome));
  expect(seenRequests.length).toBeGreaterThanOrEqual(3);
  expect(outcome.state.boundaryEventId).toBe("t6-final");
  expect(outcome.state.generation).toBe(1);

  // All-or-nothing when a later batch fails even after repair: nothing committed.
  const { log: logFail } = openLog();
  for (let t = 1; t <= 6; t++) {
    addTurn(logFail, t, { inputText: `BatchTurn-${t} ` + "b".repeat(2200) });
  }
  addTurn(logFail, 7, { inputText: "In-flight turn 7" });
  const failedOutcome = await runCompaction({
    log: logFail,
    liveRequest: live,
    contextWindowTokens: windowTokens,
    options: { effectiveMaxTokens, tailTurns: 0 },
    runSummary: async (req) => {
      const inputTok = oracleInputTokens({ systemPrompt: req.systemPrompt, tools: req.tools }, req.messages);
      expect(inputTok + effectiveMaxTokens).toBeLessThanOrEqual(windowTokens);
      return summaryResp("broken summary that never repairs");
    },
  });
  expect(failedOutcome.status).toBe("capacity_error");
  expect(readCommits(logFail.readAll({ includeInternal: true }))).toHaveLength(0);
});

test("capacity cases produce expected typed outcomes and never admit an oversized request to runSummary", async () => {
  const { runCompaction } = await api();
  let unexpectedCalls = 0;
  const neverCalled = async () => {
    unexpectedCalls++;
    return summaryResp();
  };

  // 1. Reserve >= window and invalid capacity.
  const { log: logCap } = openLog();
  addTurn(logCap, 1, { inputText: "hello" });
  expect(await runCompaction({ log: logCap, liveRequest: baseLiveRequest(), contextWindowTokens: 1000, options: { effectiveMaxTokens: 1000 }, runSummary: neverCalled }))
    .toMatchObject({ status: "capacity_error", kind: "reserve_exceeds_window" });
  expect(await runCompaction({ log: logCap, liveRequest: baseLiveRequest(), contextWindowTokens: 0, options: { effectiveMaxTokens: 100 }, runSummary: neverCalled }))
    .toMatchObject({ status: "capacity_error", kind: "invalid_capacity" });

  // 2. In-flight turn user input larger than the window.
  const { log: logHugeInput } = openLog();
  addTurn(logHugeInput, 1, { inputText: "HUGE ".repeat(2000) });
  expect(await runCompaction({ log: logHugeInput, liveRequest: baseLiveRequest(), contextWindowTokens: 1000, options: { effectiveMaxTokens: 200 }, runSummary: neverCalled }))
    .toMatchObject({ status: "capacity_error", kind: "request_exceeds_capacity" });

  // 3. Single growing tool loop where newest result alone exceeds the window (newest result is never stubbed).
  const { log: logLoop } = openLog();
  addTurn(logLoop, 1, {
    inputText: "Tool loop",
    toolResults: [
      { id: "r1", text: "OLD:".repeat(400) },
      { id: "r2", text: "NEWEST_OVERSIZED:".repeat(1500) },
    ],
  });
  expect(await runCompaction({
    log: logLoop,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 1200,
    options: { effectiveMaxTokens: 200 },
    planStubs: (c) => c.map((x) => ({ eventId: x.eventId, stubText: "stub" })),
    runSummary: neverCalled,
  })).toMatchObject({ status: "capacity_error", kind: "request_exceeds_capacity" });
  expect(readCommits(logLoop.readAll({ includeInternal: true }))).toHaveLength(0);

  // 4. Fixed prefix overhead leaves insufficient room for the in-flight turn.
  const { log: logPrefix } = openLog();
  addTurn(logPrefix, 1, { inputText: "Turn 1" });
  addTurn(logPrefix, 2, { inputText: "Turn 2 " + "z".repeat(800) });
  expect(await runCompaction({
    log: logPrefix,
    liveRequest: baseLiveRequest(),
    frame: { systemPrompt: "SYSTEM ".repeat(1000), snapshot: "SNAP ".repeat(500) },
    contextWindowTokens: 2500,
    options: { effectiveMaxTokens: 200 },
    runSummary: neverCalled,
  })).toMatchObject({ status: "capacity_error", kind: "request_exceeds_capacity" });

  // 5. Smaller fallback window after a previous successful compaction.
  {
    const { log: logFallback } = openLog();
    addTurn(logFallback, 1, { inputText: "Turn 1 " + "a".repeat(2800) });
    addTurn(logFallback, 2, { inputText: "Turn 2 " + "b".repeat(2800) });
    const first = await runCompaction({
      log: logFallback,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1900,
      options: { effectiveMaxTokens: 200, tailTurns: 0 },
      runSummary: async () => summaryResp(validSummary("Initial compaction on larger window.")),
    });
    expect(first.status).toBe("rewritten");
    expect(await runCompaction({
      log: logFallback,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 450,
      options: { effectiveMaxTokens: 200, tailTurns: 0 },
      runSummary: neverCalled,
    })).toMatchObject({ status: "capacity_error", kind: "request_exceeds_capacity" });
  }

  // 5b. Oversized single completed turn (not_foldable in batch planner) falls to Step 3/4 behaviour.
  {
    const { log: logOversizedTurn } = openLog();
    addTurn(logOversizedTurn, 1, { inputText: "Oversized completed turn " + "x".repeat(8000) });
    addTurn(logOversizedTurn, 2, {
      inputText: "In-flight turn with stubbable results",
      toolResults: [
        { id: "if-big", text: "BIG:".repeat(600) },
        { id: "if-small", text: "ok" },
      ],
    });
    const rescued = await runCompaction({
      log: logOversizedTurn,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 2400,
      options: { effectiveMaxTokens: 200, tailTurns: 0, stubKeepRecent: 1, stubMinTokens: 100 },
      planStubs: (c) => c.map((x) => ({ eventId: x.eventId, stubText: "stub" })),
      runSummary: neverCalled,
    });
    expect(rescued.status).toBe("stubbed");
    if (rescued.status !== "stubbed") throw new Error(JSON.stringify(rescued));
    expect(rescued.state.stubSet).toEqual([{ eventId: "if-big", stubText: "stub" }]);
  }

  expect(unexpectedCalls).toBe(0);

  // 6. Failed or timed-out summary or tool call in summary when unmodified request still fits -> summary_failed_fits.
  const { log: logFits } = openLog();
  addTurn(logFits, 1, { inputText: "Turn 1 " + "a".repeat(2600) });
  addTurn(logFits, 2, { inputText: "Turn 2 " + "b".repeat(1200) });
  for (const [label, responder] of [
    ["tool call in response", async () => summaryResp(validSummary(), { toolCalls: [{ id: "tc", name: "shell", args: {} }] })],
    ["over cap after repair", async () => summaryResp(validSummary("x".repeat(5000)))],
    ["timeout", async (_req: StreamRequest, { signal }: { signal: AbortSignal }) => new Promise<SummaryResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
    })],
  ] as const) {
    const res = await runCompaction({
      log: logFits,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1400,
      options: { effectiveMaxTokens: 200, summaryTimeoutMs: 25 },
      runSummary: responder,
    });
    expect(res.status).toBe("summary_failed_fits");
    if (res.status !== "summary_failed_fits") throw new Error(`${label}: ${JSON.stringify(res)}`);
    expect(res.state.generation).toBe(0);
    expect(readCommits(logFits.readAll({ includeInternal: true }))).toHaveLength(0);
  }
});

test("does not return capacity_error when summary allowance overflows but request fits unchanged, after stubbing, or after folding", async () => {
  const { runCompaction } = await api();

  // 1. Unchanged request fits (0.80 <= ratio <= 1.0), folding is not needed/possible, and adding summaryAllowanceTokens overflows usable capacity.
  {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Small" });
    addTurn(log, 2, { inputText: "In-flight " + "x".repeat(3780) });
    // usable = 1000; turn1 + turn2 ~ 983 tokens (fits, ratio ~ 0.983 >= 0.80); turn2 (~961) + minSummaryMessage (59) = 1020 > 1000.
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1200,
      options: { effectiveMaxTokens: 200, tailTurns: 0 },
      runSummary: async () => {
        throw new Error("Summary should not be needed when no valid summary can fit alongside the in-flight turn");
      },
    });
    expect(outcome.status).toBe("unchanged_fits");
    if (outcome.status !== "unchanged_fits") throw new Error(JSON.stringify(outcome));
    expect(outcome.fill.fits).toBe(true);
    expect(outcome.state.generation).toBe(0);
    expect(outcome.reason).toBe("fold_not_possible");
    expect(outcome.summaryDiscarded).toBeUndefined();
  }

  // 2. Request exceeds capacity initially, but folding completed turns into a summary that is smaller than the worst-case cap allowance fits.
  {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Completed turn 1 " + "a".repeat(900) });
    addTurn(log, 2, { inputText: "In-flight " + "b".repeat(3350) });
    // usable = 1000; turn1 (~250) + turn2 (~865) = 1115 > 1000 (!initialFill.fits).
    // turn2 (~865) + summaryAllowance (152) = 1017 > 1000, but turn2 (~865) + actual summary (~74) = 939 <= 1000.
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1200,
      options: { effectiveMaxTokens: 200, tailTurns: 0 },
      runSummary: async () => summaryResp(validSummary("Compact summary.")),
    });
    expect(outcome.status).toBe("rewritten");
    if (outcome.status !== "rewritten") throw new Error(JSON.stringify(outcome));
    expect(outcome.fill.fits).toBe(true);
    expect(outcome.state.boundaryEventId).toBe("t1-final");
  }

  // 3. Initial request fits (ratio >= 0.80) and in-flight turn has tool results within stubKeepRecent;
  // pre-check must consider maximal in-flight stubbing (keepRecent=1) rather than stopping at stubKeepRecent.
  {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Completed turn 1 " + "a".repeat(200) });
    addTurn(log, 2, {
      inputText: "In-flight with stubbable results",
      toolResults: [
        { id: "if-1", text: "R1:".repeat(550) },
        { id: "if-2", text: "R2:".repeat(550) },
        { id: "if-3", text: "ok" },
      ],
    });
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1200,
      options: { effectiveMaxTokens: 200, tailTurns: 0, stubKeepRecent: 3, stubMinTokens: 100 },
      planStubs: (c) => c.map((x) => ({ eventId: x.eventId, stubText: "stub" })),
      runSummary: async () => summaryResp(validSummary("Folded turn 1.")),
    });
    expect(outcome.status).toBe("rewritten");
    if (outcome.status !== "rewritten") throw new Error(JSON.stringify(outcome));
    expect(outcome.fill.fits).toBe(true);
    expect(outcome.state.boundaryEventId).toBe("t1-final");
  }
});

test("cancellation with controlled promises prevents every commit across primary, repair, late resolution, stubs-only, and epoch change", async () => {
  const { runCompaction } = await api();

  // 1. Already aborted before call.
  const { log: log1 } = openLog();
  addTurn(log1, 1, { toolResults: [{ id: "r1", text: "X".repeat(4000) }, { id: "r2", text: "Y".repeat(100) }] });
  const preAborted = new AbortController();
  preAborted.abort();
  const res1 = await runCompaction({
    log: log1,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 1000,
    options: { effectiveMaxTokens: 100, stubKeepRecent: 1 },
    signal: preAborted.signal,
    planStubs: () => { throw new Error("Must not stub when already aborted"); },
    runSummary: async () => { throw new Error("Must not summarize when already aborted"); },
  });
  expect(res1).toMatchObject({ status: "cancelled", reason: "aborted" });
  expect(readCommits(log1.readAll({ includeInternal: true }))).toHaveLength(0);

  // 2. Aborted during primary summary (controlled promise rejects or resolves late).
  for (const lateResolve of [false, true]) {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Turn 1 " + "a".repeat(5200) });
    addTurn(log, 2, { inputText: "Turn 2", toolResults: [{ id: "if1", text: "I".repeat(1200) }, { id: "if2", text: "ok" }] });
    const controller = new AbortController();
    const res = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 2200,
      options: { effectiveMaxTokens: 200, tailTurns: 0, stubKeepRecent: 1 },
      signal: controller.signal,
      planStubs: (c) => c.map((x) => ({ eventId: x.eventId, stubText: "stub" })),
      runSummary: async () => {
        controller.abort();
        if (lateResolve) return summaryResp(validSummary("Late summary after abort."));
        throw new Error("Aborted");
      },
    });
    expect(res.status).toBe("cancelled");
    expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
  }

  // 3. Aborted during repair attempt.
  {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Turn 1 " + "a".repeat(6000) });
    addTurn(log, 2, { inputText: "Turn 2" });
    const controller = new AbortController();
    let attempt = 0;
    const res = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 2400,
      options: { effectiveMaxTokens: 200, tailTurns: 0, contextLimitRatio: 0.70 },
      signal: controller.signal,
      runSummary: async () => {
        attempt++;
        if (attempt === 1) return summaryResp("missing headings");
        controller.abort();
        return summaryResp(validSummary("Repaired but aborted."));
      },
    });
    expect(attempt).toBe(2);
    expect(res.status).toBe("cancelled");
    expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
  }

  // 4. Aborted on a stubs-only path.
  {
    const { log } = openLog();
    addTurn(log, 1, {
      inputText: "Stubs only",
      toolResults: [{ id: "r1", text: "X".repeat(4000) }, { id: "r2", text: "Y".repeat(100) }],
    });
    const controller = new AbortController();
    const res = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1000,
      options: { effectiveMaxTokens: 100, stubKeepRecent: 1 },
      signal: controller.signal,
      planStubs: (candidates) => {
        controller.abort();
        return candidates.map((c) => ({ eventId: c.eventId, stubText: "stub" }));
      },
    });
    expect(res.status).toBe("cancelled");
    expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
  }

  // 5. Reset epoch changes while summary is in flight.
  {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Turn 1 " + "a".repeat(6000) });
    addTurn(log, 2, { inputText: "Turn 2" });
    const res = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 2100,
      options: { effectiveMaxTokens: 200, tailTurns: 0 },
      runSummary: async () => {
        addReset(log, "concurrent-clear");
        return summaryResp(validSummary("Stale epoch summary"));
      },
    });
    expect(res.status).toBe("cancelled");
    if (res.status !== "cancelled") throw new Error(JSON.stringify(res));
    expect(res.reason).toBe("reset");
    expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
  }
});

test("commit_uncertain is returned without retry when append throws, and reopening restores durable state", async () => {
  const { runCompaction } = await api();
  const { root, log } = openLog();
  addTurn(log, 1, { inputText: "Turn 1 " + "a".repeat(6000) });
  addTurn(log, 2, { inputText: "Turn 2" });

  let fsyncCalls = 0;
  const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation(() => {
    fsyncCalls++;
    throw new Error("simulated fsync failure");
  });

  const outcome = await runCompaction({
    log,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 2100,
    options: { effectiveMaxTokens: 200, tailTurns: 0 },
    runSummary: async () => summaryResp(validSummary("Durable before fsync threw.")),
  });
  fsyncSpy.mockRestore();

  expect(outcome.status).toBe("commit_uncertain");
  expect(fsyncCalls).toBe(1);

  log.close();
  const reopened = new EventLog("s", root);
  logs.push(reopened);
  const restored = restoreFrozenStateFromLog(reopened);
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw restored.error;
  expect(restored.state.generation).toBe(1);
  expect(restored.state.summary).toContain("Durable before fsync threw.");
});

test("commit_rejected is returned with reason when replay or validation rejects a commit before append", async () => {
  const { runCompaction } = await api();

  // 1. A concurrent rewrite winning the same generation is cancellation, not rejection.
  {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Turn 1 " + "a".repeat(6000) });
    addTurn(log, 2, { inputText: "Turn 2" });
    let winner: compaction.CompactionOutcome | undefined;

    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 2100,
      options: { effectiveMaxTokens: 200, tailTurns: 0 },
      runSummary: async () => {
        winner = await runCompaction({
          log,
          liveRequest: baseLiveRequest(),
          contextWindowTokens: 2100,
          options: { effectiveMaxTokens: 200, tailTurns: 0 },
          runSummary: async () => summaryResp(validSummary("Concurrent commit.")),
        });
        return summaryResp(validSummary("Conflicting summary."));
      },
    });

    expect(winner?.status).toBe("rewritten");
    expect(outcome.status).toBe("cancelled");
    if (outcome.status !== "cancelled") throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toBe("superseded");
    expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(1);
  }

  // 2. Replay rejects commit when boundary event is missing on validation readAll (e.g. torn/truncated log).
  {
    const events: Event[] = [];
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Turn 1 " + "a".repeat(6000) });
    addTurn(log, 2, { inputText: "Turn 2" });
    events.push(...log.readAll({ includeInternal: true }));
    let stripBoundaryOnValidation = false;
    const customLog = {
      readAll() {
        return stripBoundaryOnValidation ? events.filter((e) => e.event_id !== "t1-final") : events;
      },
      append(ev: Omit<Event, "event_id" | "session_id" | "timestamp">) {
        throw new Error(`Should not append rejected commit: ${JSON.stringify(ev)}`);
      },
    };

    const outcome = await runCompaction({
      log: customLog,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 2100,
      options: { effectiveMaxTokens: 200, tailTurns: 0 },
      runSummary: async () => {
        stripBoundaryOnValidation = true;
        return summaryResp(validSummary("Summary referencing missing boundary."));
      },
    });

    expect(outcome.status).toBe("commit_rejected");
    if (outcome.status !== "commit_rejected") throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toContain("boundary");
    expect(outcome.error.code).toBe("invalid_boundary");
  }

  // 3. Replay rejects stubs-only commit in Step 3 when stubbed tool result is missing on validation readAll.
  {
    const { log } = openLog();
    addTurn(log, 1, {
      inputText: "Stubs-only rejection",
      toolResults: [
        { id: "r1", text: "X".repeat(4000) },
        { id: "r2", text: "Y".repeat(100) },
      ],
    });
    const events = log.readAll({ includeInternal: true });
    let stripStubTarget = false;
    const customLog = {
      readAll() {
        return stripStubTarget ? events.filter((e) => e.event_id !== "r1") : events;
      },
      append(ev: Omit<Event, "event_id" | "session_id" | "timestamp">) {
        throw new Error(`Should not append rejected stub commit: ${JSON.stringify(ev)}`);
      },
    };

    const outcome = await runCompaction({
      log: customLog,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1000,
      options: { effectiveMaxTokens: 100, stubKeepRecent: 1 },
      planStubs: (candidates) => {
        stripStubTarget = true;
        return candidates.map((c) => ({ eventId: c.eventId, stubText: "stub" }));
      },
    });

    expect(outcome.status).toBe("commit_rejected");
    if (outcome.status !== "commit_rejected") throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toContain("stub");
    expect(outcome.error.code).toBe("invalid_stub");
  }
});

for (const phase of ["stale", "in_flight"] as const) {
  for (const race of [true, false]) {
    test(`${phase} stubs-only commit reports ${race ? "superseded" : "commit_rejected"}`, async () => {
      const { appendCommit } = await import("../src/frozen-summary.js");
      const { log } = openLog();
      if (phase === "stale") {
        addTurn(log, 1, { toolResults: [{ id: "target", text: "X".repeat(4000) }] });
        addTurn(log, 2, { inputText: "Current turn" });
      } else {
        addTurn(log, 1, { toolResults: [{ id: "target", text: "X".repeat(4000) }, { id: "newest", text: "ok" }] });
      }
      let stripTarget = false;
      const outcome = await compaction.runCompaction({
        log: {
          readAll() {
            const events = log.readAll({ includeInternal: true });
            return stripTarget ? events.filter((e) => e.event_id !== "target") : events;
          },
          append: log.append.bind(log),
        },
        liveRequest: baseLiveRequest(),
        contextWindowTokens: 1000,
        options: { effectiveMaxTokens: 100, tailTurns: 0, stubKeepRecent: 1, stubMinTokens: 100 },
        planStubs: (candidates, options) => {
          if (options.phase !== phase) throw new Error(`Expected ${phase}, got ${options.phase}`);
          if (race) {
            const winner = appendCommit(log, {
              formatVersion: 1, resetEpoch: "session_start", generation: 1,
              boundaryEventId: null, summary: null, summaryRequest: null,
              stubSet: [{ eventId: "target", stubText: "winning stub" }],
            });
            if (winner.status !== "committed") throw new Error(JSON.stringify(winner));
          } else {
            stripTarget = true;
          }
          return candidates.map((c) => ({ eventId: c.eventId, stubText: "losing stub" }));
        },
        runSummary: async () => { throw new Error("Stubs-only commits must not summarize"); },
      });
      expect(outcome).toMatchObject(race
        ? { status: "cancelled", reason: "superseded" }
        : { status: "commit_rejected", error: { code: "invalid_stub" } });
    });
  }
}

for (const code of ["invalid_generation", "invalid_epoch"] as const) {
  test(`an earlier concurrent ${code} is corruption, not a lost race`, async () => {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Turn 1 " + "a".repeat(6000) });
    addTurn(log, 2, { inputText: "Turn 2" });
    const badIndex = log.readAll({ includeInternal: true }).length;
    const outcome = await compaction.runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 2100,
      options: { effectiveMaxTokens: 200, tailTurns: 0 },
      runSummary: async () => {
        log.append({ kind: "compaction_commit", actor: "kernel", payload: {
          formatVersion: 1,
          resetEpoch: code === "invalid_epoch" ? "wrong-epoch" : "session_start",
          generation: code === "invalid_generation" ? 2 : 1,
          boundaryEventId: "t1-final",
          summary: validSummary("Malformed concurrent commit"),
          stubSet: [],
          summaryRequest: { cutDescription: "turn 1", capTokens: 200, instructionSha256: "a".repeat(64), usage: null },
        } });
        return summaryResp();
      },
    });
    expect(outcome).toMatchObject({ status: "commit_rejected", error: { code, eventIndex: badIndex } });
  });
}

test("log read failure during commit validation propagates instead of becoming commit_rejected", async () => {
  const { runCompaction } = await api();
  const { log } = openLog();
  addTurn(log, 1, { inputText: "Turn 1 " + "a".repeat(6000) });
  addTurn(log, 2, { inputText: "Turn 2" });
  const events = log.readAll({ includeInternal: true });
  let readCalls = 0;
  const failingLog = {
    readAll() {
      readCalls++;
      if (readCalls === 1) return events;
      throw new Error("simulated I/O read error");
    },
    append() {
      throw new Error("Should not append when readAll fails");
    },
  };

  await expect(runCompaction({
    log: failingLog,
    liveRequest: baseLiveRequest(),
    contextWindowTokens: 2100,
    options: { effectiveMaxTokens: 200, tailTurns: 0 },
    runSummary: async () => summaryResp(validSummary("Summary before read error.")),
  })).rejects.toThrow("simulated I/O read error");
  expect(readCalls).toBe(2);
});

test("compaction modules import nothing from src/memory/ or checkpoint.ts and do not self-import", async () => {
  await api();
  for (const rel of ["../src/compaction.ts", "../src/compaction-requests.ts"]) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*(?:checkpoint|memory)/);
  }
  const compactionSource = readFileSync(new URL("../src/compaction.ts", import.meta.url), "utf8");
  expect(compactionSource).not.toMatch(/from\s*["']\.\/compaction\.js["']/);
});

test("cache implementation details are not public API", () => {
  expect(compaction).not.toHaveProperty("stateCacheKey");
  const source = readFileSync(new URL("../src/compaction.ts", import.meta.url), "utf8");
  expect(source.includes("bypassMaterializeCache")).toBe(false);
});

async function runWithFreshFillOracle(input: compaction.RunCompactionInput & { frame: compaction.RequestFrame }) {
  const { materializeHistory, requestFill } = compaction;
  const source = structuredClone(input.log.readAll({ includeInternal: true }));
  const records: { state: FrozenState; messages: ConversationMessage[]; fill?: compaction.RequestFillResult }[] = [];
  // Capture the runner's measurements, not a second run through the same cache.
  const measureSpy = spyOn(compaction, "requestFill").mockImplementation((...args) => {
    const measured = requestFill(...args);
    const record = records.find((r) => r.messages === args[1]);
    if (record) record.fill = measured;
    return measured;
  });
  let outcome: compaction.CompactionOutcome;
  try {
    outcome = await compaction.runCompaction({
      ...input,
      materialize: (state, events) => {
        const mat = (input.materialize ?? materializeHistory)(state, events);
        if (!mat.ok) throw mat.error;
        records.push({ state: structuredClone(state), messages: mat.messages });
        return mat;
      },
    });
  } finally {
    measureSpy.mockRestore();
  }
  const freshFill = (state: FrozenState) => {
    const mat = materializeHistory(state, source);
    if (!mat.ok) throw mat.error;
    return requestFill(input.frame, mat.messages, input.contextWindowTokens, input.options);
  };
  for (const record of records) expect(record.fill).toEqual(freshFill(record.state));
  if ("fill" in outcome && "state" in outcome) {
    expect({ ok: true, fill: outcome.fill }).toEqual(freshFill(outcome.state));
  }
  // The identity oracle is deliberately independent of the production cache key.
  const keys = records.map(({ state }) => JSON.stringify([
    state.resetEpoch, state.boundaryEventId, state.summary,
    state.stubSet.map((s) => [s.eventId, s.stubText]).sort(),
  ]));
  expect(records.length).toBe(new Set(keys).size);
  expect(records.length).toBeLessThanOrEqual(3 + 2 * (input.options?.stubKeepRecent ?? 3));
  return outcome;
}

const oracleFrame: compaction.RequestFrame = {
  systemPrompt: "Follow the repository conventions. ".repeat(3),
  tools: [{ name: "shell", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } } } }],
};

test("materialises each distinct state at most once with fresh full-frame fill measurements", async () => {
  let seed = 0x7f4a7c15;
  const rand = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };

  for (let scenario = 0; scenario < 100; scenario++) {
    const buildScenarioEvents = (): Event[] => {
      const evs: Event[] = [];
      let localSeed = (seed + scenario * 9973) >>> 0;
      const localRand = (max: number) => {
        localSeed = (Math.imul(localSeed, 1664525) + 1013904223) >>> 0;
        return localSeed % max;
      };
      const turns = 1 + localRand(7);
      for (let t = 1; t <= turns; t++) {
        const p = `m${scenario}-t${t}`;
        evs.push({
          event_id: `${p}-in`,
          session_id: "s",
          timestamp: evs.length + 1,
          kind: "canonical_message",
          actor: "kernel",
          payload: { formatVersion: 1, kind: "user_input", turnId: t, message: { text: "u".repeat(20 + localRand(400)) } },
        });
        const rc = localRand(6);
        for (let r = 0; r < rc; r++) {
          const cid = `${p}-c${r}`;
          evs.push({
            event_id: `${p}-a${r}`,
            session_id: "s",
            timestamp: evs.length + 1,
            kind: "canonical_message",
            actor: "kernel",
            payload: { formatVersion: 1, kind: "assistant", turnId: t, message: { text: "call", toolCalls: [{ id: cid, name: "shell", args: { r } }] } },
          });
          evs.push({
            event_id: `${p}-r${r}`,
            session_id: "s",
            timestamp: evs.length + 1,
            kind: "canonical_message",
            actor: "kernel",
            payload: { formatVersion: 1, kind: "tool_result", turnId: t, message: { callId: cid, toolName: "shell", text: "r".repeat(40 + localRand(800)), isError: false } },
          });
        }
        evs.push({
          event_id: `${p}-done`,
          session_id: "s",
          timestamp: evs.length + 1,
          kind: "canonical_message",
          actor: "kernel",
          payload: { formatVersion: 1, kind: "assistant", turnId: t, message: { text: "a".repeat(20 + localRand(200)) } },
        });
      }
      return evs;
    };

    const windowTokens = 600 + rand(2400);
    const effectiveMaxTokens = 100 + rand(300);
    const tailTurns = rand(5);
    const stubKeepRecent = 1 + rand(3);
    const stubMinTokens = 50 + rand(150);
    const mode = rand(5);

    const events = buildScenarioEvents();
    const makeLog = (evs: Event[]) => ({
      readAll() { return evs; },
      append(partial: Omit<Event, "event_id" | "session_id" | "timestamp">) {
        const ev: Event = { ...partial, event_id: `ev-${scenario}-${evs.length}`, session_id: "s", timestamp: evs.length + 1 };
        evs.push(ev);
        return ev;
      },
    });

    let summaryCalls = 0;
    await runWithFreshFillOracle({
      log: makeLog(events),
      liveRequest: baseLiveRequest(),
      frame: oracleFrame,
      contextWindowTokens: windowTokens,
      options: { effectiveMaxTokens, tailTurns, stubKeepRecent, stubMinTokens },
      planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: `[stub:${c.eventId}]` })),
      runSummary: async () => {
        summaryCalls++;
        if (mode === 4) return summaryResp("invalid summary");
        if (mode === 3 && summaryCalls % 2 === 1) return summaryResp("needs repair");
        return summaryResp(validSummary(`Scenario ${scenario}`));
      },
    });
  }

  // A growing fold skips post-fold stubbing; only the unfolded Step 3 fallback is measured.
  {
    const { log } = openLog();
    addTurn(log, 1, {
      inputText: "T1",
      toolResults: [{ id: "stale-1", text: "S".repeat(800) }],
    });
    addTurn(log, 2, {
      inputText: "U".repeat(2680),
      toolResults: [
        { id: "if-1", text: "A".repeat(400) },
        { id: "if-2", text: "B".repeat(400) },
        { id: "if-3", text: "C".repeat(400) },
        { id: "if-4", text: "ok" },
      ],
    });
    let bothPathCalls = 0;
    const bothPathKeys = new Set<string>();
    const stubKeepRecent = 2;
    const outcome = await runWithFreshFillOracle({
      log,
      liveRequest: baseLiveRequest(),
      frame: {},
      contextWindowTokens: 1200,
      options: { effectiveMaxTokens: 200, tailTurns: 0, stubKeepRecent, stubMinTokens: 50 },
      planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: "s" })),

      materialize: (state, source) => {
        bothPathCalls++;
        bothPathKeys.add(JSON.stringify([state.resetEpoch, state.boundaryEventId, state.summary, state.stubSet]));
        return compaction.materializeHistory(state, source);
      },
      runSummary: async () => summaryResp(validSummary("S".repeat(280))),
    });
    expect(outcome.status).toBe("stubbed");
    expect(outcome.summaryDiscarded).toBe(true);
    expect(bothPathCalls).toBe(bothPathKeys.size);
    expect(bothPathCalls).toBe(3 + stubKeepRecent);
  }
});

for (const status of ["cancelled", "capacity_error"] as const) {
  test(`fresh full-frame fill oracle checks intermediate measurements ending in ${status}`, async () => {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "old".repeat(1300) });
    addTurn(log, 2, {
      inputText: status === "capacity_error" ? "U".repeat(8000) : "new",
      toolResults: [{ id: "older", text: "X".repeat(1600) }, { id: "newest", text: "ok" }],
    });
    const controller = new AbortController();
    const outcome = await runWithFreshFillOracle({
      log, liveRequest: baseLiveRequest(), frame: oracleFrame,
      contextWindowTokens: 2000,
      options: { effectiveMaxTokens: 200, tailTurns: 0, stubKeepRecent: 1, stubMinTokens: 50 },
      signal: controller.signal,
      runSummary: async () => { controller.abort(); return summaryResp(); },
    });
    expect(outcome.status).toBe(status);
  });
}

test("unchanged_fits requires a diagnostic reason in its public type", () => {
  const source = readFileSync(new URL("../src/compaction.ts", import.meta.url), "utf8");
  expect(/status: "unchanged_fits";[^\n]*reason: UnchangedFitsReason/.test(source)).toBe(true);
});

for (const decline of ["empty", "ineligible"] as const) {
  test(`unchanged_fits reports planner_declined for ${decline} plans`, async () => {
    const { log } = openLog();
    addTurn(log, 1, {
      inputText: "u".repeat(200),
      toolResults: [{ id: "older", text: "X".repeat(1400) }, { id: "newest", text: "Y".repeat(1400) }],
    });
    const outcome = await compaction.runCompaction({
      log, liveRequest: baseLiveRequest(), contextWindowTokens: 1100,
      options: { effectiveMaxTokens: 100, stubKeepRecent: 1, stubMinTokens: 100 },
      planStubs: (candidates) => decline === "empty" ? [] : [
        { eventId: "unknown", stubText: "s" },
        ...candidates.map((c) => ({ eventId: c.eventId, stubText: "larger".repeat(2000) })),
      ],
    });
    expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "planner_declined" });
  });
}

test("unchanged_fits reports no_eligible_results without an active turn", async () => {
  const { log } = openLog();
  const outcome = await compaction.runCompaction({
    log, liveRequest: baseLiveRequest(), frame: { systemPrompt: "X".repeat(3600) },
    contextWindowTokens: 1100, options: { effectiveMaxTokens: 100 },
  });
  expect(outcome).toMatchObject({ status: "unchanged_fits", reason: "no_eligible_results" });
});

test("unchanged_fits distinguishes impossible and non-beneficial folds from no eligible results, and marks discarded summaries", async () => {
  const { runCompaction } = await api();

  // 1. no_eligible_results: single in-flight turn above trigger with no eligible tool results.
  {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "x".repeat(3600) });
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1100,
      options: { effectiveMaxTokens: 100 },
    });
    expect(outcome.status).toBe("unchanged_fits");
    if (outcome.status !== "unchanged_fits") throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toBe("no_eligible_results");
    expect(outcome.summaryDiscarded).toBeUndefined();
  }

  // 2. fold_not_possible (batch planner returns not_foldable when a single completed turn exceeds batch capacity).
  {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Completed turn " + "a".repeat(3700) });
    addTurn(log, 2, { inputText: "Small tail" });
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1200,
      options: { effectiveMaxTokens: 200, tailTurns: 0 },
      runSummary: async () => {
        throw new Error("Should not summarize when completed turn is not_foldable");
      },
    });
    expect(outcome.status).toBe("unchanged_fits");
    if (outcome.status !== "unchanged_fits") throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toBe("fold_not_possible");
    expect(outcome.summaryDiscarded).toBeUndefined();
  }

  // 3. fold_not_beneficial: the accepted summary grows the request and also exceeds capacity.
  {
    const { log } = openLog();
    const writer = new CanonicalWriter(log, (error) => { throw error; });
    const completed = await writer.startTurn("c".repeat(220));
    await writer.assistant(completed, { role: "assistant", content: "done" });
    const current = await writer.startTurn("In-flight " + "y".repeat(4400));
    await writer.assistant(current, { role: "assistant", content: "running" });
    // The minimum summary would shrink the completed turn; the larger accepted summary overflows.
    // The original request still fits usable = 1200, and capTokens = 150.
    let summaryCalls = 0;
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1400,
      options: { effectiveMaxTokens: 200, tailTurns: 0 },
      runSummary: async () => {
        summaryCalls++;
        return summaryResp(validSummary("D".repeat(380)));
      },
    });
    expect(summaryCalls).toBe(1);
    expect(outcome.status).toBe("unchanged_fits");
    if (outcome.status !== "unchanged_fits") throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toBe("fold_not_beneficial");
    expect(outcome.summaryDiscarded).toBe(true);
    expect(outcome.state.generation).toBe(0);
    expect(readCommits(log.readAll({ includeInternal: true }))).toHaveLength(0);
  }
});

test("custom planStubs entries outside the eligible set are ignored in both Step 2 pre-check and runInFlightStubbing", async () => {
  const { runCompaction } = await api();
  const { appendCommit } = await import("../src/frozen-summary.js");

  // 1. Step 2 pre-check: custom planner attempts to stub already-stubbed id, newest id, and unknown id.
  // If newest (if-3, ~750 tokens) were accepted by pre-check, minInFlightTokens would drop enough to pass pre-check and call runSummary.
  // Because ineligible ids are ignored, only if-2 is stubbed, pre-check fails, and runSummary is never called.
  {
    const { log } = openLog();
    addTurn(log, 1, { inputText: "Completed turn 1" });
    addTurn(log, 2, {
      inputText: "In-flight turn 2",
      toolResults: [
        { id: "if-1", text: "A".repeat(400) },
        { id: "if-2", text: "B".repeat(400) },
        { id: "if-3", text: "N".repeat(2800) },
      ],
    });
    expect(appendCommit(log, {
      formatVersion: 1,
      resetEpoch: "session_start",
      generation: 1,
      boundaryEventId: null,
      summary: null,
      stubSet: [{ eventId: "if-1", stubText: "already-stubbed" }],
      summaryRequest: null,
    })).toEqual({ status: "committed" });

    let summaryCalls = 0;
    const preCheckCandidates: string[][] = [];
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 1125,
      options: { effectiveMaxTokens: 200, tailTurns: 0, stubKeepRecent: 1, stubMinTokens: 50 },
      planStubs: (candidates) => {
        preCheckCandidates.push(candidates.map((c) => c.eventId));
        return [
          ...candidates.map((c) => ({ eventId: c.eventId, stubText: "s" })),
          { eventId: "if-1", stubText: "overwrite" },
          { eventId: "if-3", stubText: "s" },
          { eventId: "unknown-id", stubText: "s" },
        ];
      },
      runSummary: async () => {
        summaryCalls++;
        return summaryResp();
      },
    });
    expect(summaryCalls).toBe(0);
    expect(preCheckCandidates[0]).toEqual(["if-2"]);
    expect(outcome.status).toBe("stubbed");
    if (outcome.status !== "stubbed") throw new Error(JSON.stringify(outcome));
    expect(outcome.state.stubSet).toEqual([
      { eventId: "if-1", stubText: "already-stubbed" },
      { eventId: "if-2", stubText: "s" },
    ]);
  }

  // 2. runInFlightStubbing: custom planner attempts to overwrite already-stubbed id, stub newest id, and add unknown id.
  {
    const { log } = openLog();
    addTurn(log, 1, {
      inputText: "Single turn",
      toolResults: [
        { id: "r1", text: "A".repeat(400) },
        { id: "r2", text: "B".repeat(1600) },
        { id: "r3", text: "N".repeat(200) },
      ],
    });
    expect(appendCommit(log, {
      formatVersion: 1,
      resetEpoch: "session_start",
      generation: 1,
      boundaryEventId: null,
      summary: null,
      stubSet: [{ eventId: "r1", stubText: "already-stubbed" }],
      summaryRequest: null,
    })).toEqual({ status: "committed" });

    const seenCandidates: string[][] = [];
    const outcome = await runCompaction({
      log,
      liveRequest: baseLiveRequest(),
      contextWindowTokens: 800,
      options: { effectiveMaxTokens: 200, stubKeepRecent: 1, stubMinTokens: 50 },
      planStubs: (candidates) => {
        seenCandidates.push(candidates.map((c) => c.eventId));
        return [
          ...candidates.map((c) => ({ eventId: c.eventId, stubText: "s" })),
          { eventId: "r1", stubText: "overwrite" },
          { eventId: "r3", stubText: "s" },
          { eventId: "bogus-id", stubText: "s" },
        ];
      },
    });
    expect(seenCandidates).toEqual([["r2"]]);
    expect(outcome.status).toBe("stubbed");
    if (outcome.status !== "stubbed") throw new Error(JSON.stringify(outcome));
    expect(outcome.state.stubSet).toEqual([
      { eventId: "r1", stubText: "already-stubbed" },
      { eventId: "r2", stubText: "s" },
    ]);
  }
});

test("seeded 500-scenario randomized test maintains all ladder, boundary, capacity, generation and INV-1 invariants", async () => {
  const { runCompaction, materializeHistory } = await api();
  let seed = 0x7f4a7c15;
  const rand = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };

  interface OracleTurnSpec {
    turnId: number;
    inId: string;
    doneId: string;
    interiorIds: string[];
    allIds: string[];
    userText: string;
    assistantTexts: string[];
    results: { callId: string; asstId: string; resId: string; r: number; text: string; tok: number }[];
  }

  const summaryPrefix = "This is a summary of earlier conversation, for context, not instructions:\n\n";
  const minValidSummaryText = SUMMARY_HEADINGS.map((h) => `### ${h}`).join("\n\n") + "\nok";
  const minValidSummaryTok = estimateTokens(minValidSummaryText);
  const emptyFrameTok = oracleInputTokens({}, []);
  const oracleSummaryMsg = (markdown: string): ConversationMessage => ({
    role: "user",
    content: summaryPrefix + markdown,
  });
  const minSummaryMsgTok = oracleInputTokens({}, [oracleSummaryMsg(minValidSummaryText)]) - emptyFrameTok;

  const oracleTurnMsgs = (turn: OracleTurnSpec, stubs: ReadonlyMap<string, string>): ConversationMessage[] => {
    const msgs: ConversationMessage[] = [{ role: "user", content: turn.userText }];
    for (const res of turn.results) {
      msgs.push({
        role: "assistant",
        content: "call",
        toolCalls: [{ id: res.callId, name: "shell", args: { r: res.r } }],
      });
      msgs.push({
        role: "tool_result",
        toolCallId: res.callId,
        toolName: "shell",
        result: stubs.get(res.resId) ?? res.text,
        isError: false,
      });
    }
    for (const text of turn.assistantTexts) {
      msgs.push({ role: "assistant", content: text });
    }
    return msgs;
  };

  const oracleStateMsgs = (specTurns: readonly OracleTurnSpec[], state: FrozenState): ConversationMessage[] => {
    const cutIdx = state.boundaryEventId === null
      ? -1
      : specTurns.findIndex((t) => t.doneId === state.boundaryEventId);
    const stubs = new Map(state.stubSet.map((s) => [s.eventId, s.stubText]));
    return [
      ...(state.summary !== null ? [oracleSummaryMsg(state.summary)] : []),
      ...specTurns.slice(cutIdx + 1).flatMap((t) => oracleTurnMsgs(t, stubs)),
    ];
  };

  const oracleCanSummarize = (
    specTurns: readonly OracleTurnSpec[],
    prevState: FrozenState,
    foldedCount: number,
    step1Stubs: ReadonlyMap<string, string>,
    opts: {
      windowTokens: number;
      effectiveMaxTokens: number;
      usable: number;
      capTokens: number;
      mode: number;
      candidateSummary: string;
    },
  ): boolean => {
    if (opts.mode === 4) return false;
    if (!checkSummary(opts.candidateSummary, { capTokens: opts.capTokens }).ok) return false;
    const prevCutIdx = prevState.boundaryEventId === null
      ? -1
      : specTurns.findIndex((t) => t.doneId === prevState.boundaryEventId);
    const activeTurns = specTurns.slice(prevCutIdx + 1);
    const completed = activeTurns.slice(0, -1);
    const foldedSpec = completed.slice(0, foldedCount);
    const lastFolded = foldedSpec.at(-1)!;
    const cutText = `through turn ${lastFolded.turnId} (${lastFolded.doneId})`;
    const liveReq: StreamRequest = {
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      messages: oracleStateMsgs(specTurns, prevState),
    };
    const instrOpts = {
      cutDescription: cutText,
      capTokens: opts.capTokens,
      ...(prevState.summary !== null ? { previousSummary: prevState.summary } : {}),
    };
    const instruction = buildSummaryInstruction(instrOpts);
    const sameModelReq = buildSameModelSummaryRequest(liveReq, instruction);
    if (oracleInputTokens({}, sameModelReq.messages) <= opts.usable) {
      if (opts.mode !== 3) return true;
      const rep = buildSummaryRepairRequest(
        sameModelReq,
        { text: "needs repair", finishReason: "stop", toolCalls: [] },
        {
          capTokens: opts.capTokens,
          contextWindowTokens: opts.windowTokens,
          effectiveMaxTokens: opts.effectiveMaxTokens,
          attempt: 0,
        },
      );
      return rep.status === "repair" && oracleInputTokens({}, rep.request.messages) <= opts.usable;
    }
    const foldedTurnsForBatch = foldedSpec.map((t) => ({
      turnId: t.turnId,
      completed: true,
      eventIds: t.allIds,
      records: [],
      messages: oracleTurnMsgs(t, step1Stubs),
      estimatedTokens: 0,
    }));
    const planned = planBatchSummaries(liveReq, foldedTurnsForBatch, {
      ...instrOpts,
      contextWindowTokens: opts.windowTokens,
      effectiveMaxTokens: opts.effectiveMaxTokens,
    });
    if (planned.status !== "planned") return false;
    const attempts: BatchSummaryAttempt[] = [];
    let callNum = 0;
    while (true) {
      const step = nextBatchSummaryRequest(planned.plan, attempts);
      if (step.status === "complete") return true;
      if (step.status !== "request") return false;
      callNum++;
      const res: SummaryResult = opts.mode === 3 && callNum % 2 === 1
        ? { text: "needs repair", finishReason: "stop", toolCalls: [] }
        : { text: opts.candidateSummary, finishReason: "stop", toolCalls: [] };
      if (step.attempt === 0) attempts.push({ result: res });
      else attempts[step.batchIndex] = { ...attempts[step.batchIndex], repair: res };
    }
  };

  for (let scenario = 0; scenario < 500; scenario++) {
    const events: Event[] = [];
    const mockLog = {
      readAll() { return events; },
      append(partial: Omit<Event, "event_id" | "session_id" | "timestamp">) {
        const ev: Event = {
          ...partial,
          event_id: `ev-${scenario}-${events.length}`,
          session_id: "s",
          timestamp: events.length + 1,
        };
        events.push(ev);
        return ev;
      },
    };

    const specTurns: OracleTurnSpec[] = [];
    const appendSpecTurn = (t: number) => {
      const idPrefix = `s${scenario}-t${t}`;
      const inId = `${idPrefix}-in`;
      const userText = "u".repeat(20 + rand(400));
      events.push({
        event_id: inId,
        session_id: "s",
        timestamp: events.length + 1,
        kind: "canonical_message",
        actor: "kernel",
        payload: { formatVersion: 1, kind: "user_input", turnId: t, message: { text: userText } },
      });
      const resultCount = rand(5);
      const results: OracleTurnSpec["results"] = [];
      const interiorIds = [inId];
      for (let r = 0; r < resultCount; r++) {
        const callId = `${idPrefix}-c${r}`;
        const asstId = `${idPrefix}-a${r}`;
        const resId = `${idPrefix}-r${r}`;
        const resText = "r".repeat(40 + rand(800));
        interiorIds.push(asstId, resId);
        results.push({ callId, asstId, resId, r, text: resText, tok: estimateTokens(resText) });
        events.push({
          event_id: asstId,
          session_id: "s",
          timestamp: events.length + 1,
          kind: "canonical_message",
          actor: "kernel",
          payload: {
            formatVersion: 1,
            kind: "assistant",
            turnId: t,
            message: { text: "call", toolCalls: [{ id: callId, name: "shell", args: { r } }] },
          },
        });
        events.push({
          event_id: resId,
          session_id: "s",
          timestamp: events.length + 1,
          kind: "canonical_message",
          actor: "kernel",
          payload: {
            formatVersion: 1,
            kind: "tool_result",
            turnId: t,
            message: { callId, toolName: "shell", text: resText, isError: false },
          },
        });
      }
      const doneId = `${idPrefix}-done`;
      const doneText = "a".repeat(20 + rand(200));
      events.push({
        event_id: doneId,
        session_id: "s",
        timestamp: events.length + 1,
        kind: "canonical_message",
        actor: "kernel",
        payload: { formatVersion: 1, kind: "assistant", turnId: t, message: { text: doneText } },
      });
      specTurns.push({
        turnId: t,
        inId,
        doneId,
        interiorIds,
        allIds: [...interiorIds, doneId],
        userText,
        assistantTexts: [doneText],
        results,
      });
    };

    const turnCount = 1 + rand(7);
    for (let t = 1; t <= turnCount; t++) appendSpecTurn(t);

    const windowTokens = 600 + rand(2400);
    const effectiveMaxTokens = 100 + rand(300);
    const tailTurns = rand(5);
    const stubKeepRecent = 1 + rand(3);
    const stubMinTokens = 50 + rand(150);
    const mode = rand(5); // 0..2: valid summary, 3: repairable once, 4: summary fails
    const usable = windowTokens - effectiveMaxTokens;

    const stateGraph = new StateGraph();
    stateGraph.create("note", { text: "state note" });

    for (let pass = 1; pass <= 2; pass++) {
      const passMode = pass === 2 && mode === 4 ? 0 : mode;
      const prevRestored = restoreFrozenStateFromLog(mockLog);
      expect(prevRestored.ok).toBe(true);
      if (!prevRestored.ok) throw prevRestored.error;
      const prevState = prevRestored.state;
      const prevCutIdx = prevState.boundaryEventId === null
        ? -1
        : specTurns.findIndex((t) => t.doneId === prevState.boundaryEventId);
      const activeSpecTurns = specTurns.slice(prevCutIdx + 1);
      const completedSpecTurns = activeSpecTurns.slice(0, -1);
      const inFlightSpec = activeSpecTurns.at(-1)!;
      const activeResultIds = new Set(activeSpecTurns.flatMap((t) => t.results.map((r) => r.resId)));
      const baseStubs = new Map<string, string>();
      for (const s of prevState.stubSet) {
        if (activeResultIds.has(s.eventId)) baseStubs.set(s.eventId, s.stubText);
      }

      // Independent oracle model for expected boundary, tail, and fit.
      const unchangedTokens = oracleInputTokens({}, oracleStateMsgs(specTurns, prevState));
      const unchangedFits = unchangedTokens <= usable;

      const staleSpecTurns = completedSpecTurns.slice(0, Math.max(0, completedSpecTurns.length - tailTurns));
      const step1Stubs = new Map(baseStubs);
      for (const t of staleSpecTurns) {
        for (const r of t.results) {
          if (!step1Stubs.has(r.resId) && r.tok >= stubMinTokens) {
            step1Stubs.set(r.resId, `[stub:${r.resId}]`);
          }
        }
      }
      const maxInFlightStubs = (starting: ReadonlyMap<string, string>) => {
        const m = new Map(starting);
        for (let i = 0; i < Math.max(0, inFlightSpec.results.length - 1); i++) {
          const r = inFlightSpec.results[i];
          if (!m.has(r.resId) && r.tok >= stubMinTokens) {
            m.set(r.resId, `[stub:${r.resId}]`);
          }
        }
        return m;
      };
      const unfoldedMaxStubs = maxInFlightStubs(step1Stubs);
      const unfoldedMaxMsgs = [
        ...(prevState.summary !== null ? [oracleSummaryMsg(prevState.summary)] : []),
        ...activeSpecTurns.flatMap((t) => oracleTurnMsgs(t, unfoldedMaxStubs)),
      ];
      const stubsOnlyFits =
        unfoldedMaxStubs.size > baseStubs.size && oracleInputTokens({}, unfoldedMaxMsgs) <= usable;

      const capTokens = Math.min(4096, Math.floor(usable / 8));
      const allowanceTokens = (oracleInputTokens({}, [oracleSummaryMsg("")]) - emptyFrameTok) + capTokens;
      let expectedKeepCompleted = 0;
      for (let keep = Math.min(tailTurns, completedSpecTurns.length); keep >= 0; keep--) {
        const foldedCount = completedSpecTurns.length - keep;
        if (foldedCount <= 0) continue;
        const tailSlice = [...completedSpecTurns.slice(foldedCount), inFlightSpec];
        const prospective = oracleInputTokens({}, tailSlice.flatMap((t) => oracleTurnMsgs(t, baseStubs))) + allowanceTokens;
        if (prospective <= usable && prospective / usable <= 0.65) {
          expectedKeepCompleted = keep;
          break;
        }
      }
      const expectedFoldedCount = completedSpecTurns.length - expectedKeepCompleted;
      const expectedBoundaryId = completedSpecTurns.length > 0
        ? completedSpecTurns[expectedFoldedCount - 1].doneId
        : null;
      const expectedRetainedSpec = completedSpecTurns.length > 0
        ? [...completedSpecTurns.slice(expectedFoldedCount), inFlightSpec]
        : [inFlightSpec];

      const candidateSummary = validSummary(`Scenario ${scenario} pass ${pass}`);
      const minInFlightTok = oracleInputTokens({}, oracleTurnMsgs(inFlightSpec, maxInFlightStubs(baseStubs)));
      let foldCanFit = false;
      if (
        completedSpecTurns.length > 0 &&
        capTokens >= minValidSummaryTok &&
        minInFlightTok + minSummaryMsgTok <= usable &&
        oracleCanSummarize(specTurns, prevState, expectedFoldedCount, step1Stubs, {
          windowTokens,
          effectiveMaxTokens,
          usable,
          capTokens,
          mode: passMode,
          candidateSummary,
        })
      ) {
        const retainedIds = new Set(expectedRetainedSpec.flatMap((t) => t.results.map((r) => r.resId)));
        const retainedBaseStubs = new Map<string, string>();
        for (const [k, v] of baseStubs) {
          if (retainedIds.has(k)) retainedBaseStubs.set(k, v);
        }
        const foldedMaxStubs = maxInFlightStubs(retainedBaseStubs);
        const foldedMaxMsgs = [
          oracleSummaryMsg(candidateSummary),
          ...expectedRetainedSpec.flatMap((t) => oracleTurnMsgs(t, foldedMaxStubs)),
        ];
        foldCanFit = oracleInputTokens({}, foldedMaxMsgs) <= usable;
      }

      const oracleAnythingFits = unchangedFits || stubsOnlyFits || foldCanFit;

      let callCount = 0;
      const outcome = await runCompaction({
        log: mockLog,
        liveRequest: baseLiveRequest(),
        contextWindowTokens: windowTokens,
        options: { effectiveMaxTokens, tailTurns, stubKeepRecent, stubMinTokens },
        planStubs: (candidates) => candidates.map((c) => ({ eventId: c.eventId, stubText: `[stub:${c.eventId}]` })),
        runSummary: async (req) => {
          callCount++;
          const inputTok = oracleInputTokens({ systemPrompt: req.systemPrompt, tools: req.tools }, req.messages);
          expect(inputTok + effectiveMaxTokens).toBeLessThanOrEqual(windowTokens);
          if (passMode === 4) return summaryResp("invalid summary");
          if (passMode === 3 && callCount % 2 === 1) return summaryResp("needs repair");
          return summaryResp(candidateSummary);
        },
      });

      const restored = restoreFrozenStateFromLog(mockLog);
      expect(restored.ok).toBe(true);
      if (!restored.ok) throw restored.error;
      const nextState = restored.state;

      // (a) Boundary invariant: never inside a turn, never includes the in-flight turn, and matches expected boundary & tail.
      const allInteriorIds = new Set(specTurns.flatMap((t) => t.interiorIds));
      const inFlightAllIds = new Set(inFlightSpec.allIds);
      const validBoundaryIds = new Set(specTurns.slice(0, -1).map((t) => t.doneId));
      if (nextState.boundaryEventId !== null) {
        expect(allInteriorIds.has(nextState.boundaryEventId)).toBe(false);
        expect(inFlightAllIds.has(nextState.boundaryEventId)).toBe(false);
        expect(validBoundaryIds.has(nextState.boundaryEventId)).toBe(true);
      }
      if (outcome.status === "rewritten") {
        expect(nextState.boundaryEventId).toBe(expectedBoundaryId);
        expect(nextState.summary).toBe(candidateSummary);
        const expectedTailMsgs = [
          oracleSummaryMsg(candidateSummary),
          ...expectedRetainedSpec.flatMap((t) =>
            oracleTurnMsgs(t, new Map(nextState.stubSet.map((s) => [s.eventId, s.stubText]))),
          ),
        ];
        const actualMat = materializeHistory(nextState, events);
        expect(actualMat.ok).toBe(true);
        if (!actualMat.ok) throw actualMat.error;
        expect(actualMat.messages).toEqual(expectedTailMsgs);
      }

      // (b) Committed result fits usable capacity (measured by independent oracle, not outcome.fill.fits).
      const committed = outcome.status === "rewritten" || outcome.status === "stubbed";
      if (committed) {
        expect(outcome.state).toEqual(nextState);
        const oracleCommittedMsgs = oracleStateMsgs(specTurns, nextState);
        const oracleCommittedTokens = oracleInputTokens({}, oracleCommittedMsgs);
        expect(oracleCommittedTokens).toBeLessThanOrEqual(usable);
        expect(outcome.fill.inputTokens).toBe(oracleCommittedTokens);
        expect(outcome.fill.usableTokens).toBe(usable);
      }

      // (c) capacity_error only when the independent model says nothing fits.
      expect(outcome.status === "capacity_error").toBe(!oracleAnythingFits);
      if (outcome.status !== "capacity_error") {
        const oracleFinalTokens = oracleInputTokens({}, oracleStateMsgs(specTurns, nextState));
        expect(oracleFinalTokens).toBeLessThanOrEqual(usable);
      }

      // (d) Generations and stub maps are monotonic.
      expect(nextState.generation).toBeGreaterThanOrEqual(prevState.generation);
      expect(nextState.generation).toBe(committed ? prevState.generation + 1 : prevState.generation);
      const nextCutIdx = nextState.boundaryEventId === null
        ? -1
        : specTurns.findIndex((t) => t.doneId === nextState.boundaryEventId);
      expect(nextCutIdx).toBeGreaterThanOrEqual(prevCutIdx);
      const retainedResultIds = new Set(
        specTurns.slice(nextCutIdx + 1).flatMap((t) => t.results.map((r) => r.resId)),
      );
      const foldedTurnIds = new Set(specTurns.slice(0, nextCutIdx + 1).flatMap((t) => t.allIds));
      const nextStubMap = new Map(nextState.stubSet.map((s) => [s.eventId, s.stubText]));
      for (const prevStub of prevState.stubSet) {
        if (retainedResultIds.has(prevStub.eventId)) {
          expect(nextStubMap.get(prevStub.eventId)).toBe(prevStub.stubText);
        }
      }
      for (const stub of nextState.stubSet) {
        expect(foldedTurnIds.has(stub.eventId)).toBe(false);
        expect(retainedResultIds.has(stub.eventId)).toBe(true);
      }

      if (pass === 1) {
        // INV-1 check after appending a new complete record to the in-flight turn, then add a turn for pass 2.
        const beforeMat = materializeHistory(nextState, events);
        expect(beforeMat.ok).toBe(true);
        if (!beforeMat.ok) throw beforeMat.error;
        const appendedEv = mockLog.append({
          kind: "canonical_message",
          actor: "kernel",
          payload: { formatVersion: 1, kind: "assistant", turnId: inFlightSpec.turnId, message: { text: "appended step" } },
        });
        const afterMat = materializeHistory(nextState, events);
        expect(afterMat.ok).toBe(true);
        if (!afterMat.ok) throw afterMat.error;
        expect(afterMat.messages.slice(0, beforeMat.messages.length)).toEqual(beforeMat.messages);
        expect(afterMat.messages.at(-1)).toEqual({ role: "assistant", content: "appended step" });

        inFlightSpec.interiorIds.push(inFlightSpec.doneId);
        inFlightSpec.doneId = appendedEv.event_id;
        inFlightSpec.allIds.push(appendedEv.event_id);
        inFlightSpec.assistantTexts.push("appended step");
        appendSpecTurn(turnCount + 1);
        appendSpecTurn(turnCount + 2);
      }
    }
  }
});
