import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalRecord } from "../src/canonical-transcript.js";
import type { SummaryResult } from "../src/compaction-requests.js";
import { EventLog, type EventLogOptions } from "../src/event-log.js";
import { readCommits, restoreFrozenStateFromLog, SUMMARY_HEADINGS } from "../src/frozen-summary.js";
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
  expect(res1.status).toBe("cancelled");
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

test("compaction modules import nothing from src/memory/ or checkpoint.ts", async () => {
  await api();
  for (const rel of ["../src/compaction.ts", "../src/compaction-requests.ts"]) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*(?:checkpoint|memory)/);
  }
});

test("seeded 500-scenario randomized test maintains all ladder, boundary, capacity, generation and INV-1 invariants", async () => {
  const { runCompaction, buildTurns, materializeHistory } = await api();
  let seed = 0x7f4a7c15;
  const rand = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
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

    const turnCount = 1 + rand(7);
    for (let t = 1; t <= turnCount; t++) {
      const idPrefix = `s${scenario}-t${t}`;
      events.push({
        event_id: `${idPrefix}-in`,
        session_id: "s",
        timestamp: events.length + 1,
        kind: "canonical_message",
        actor: "kernel",
        payload: { formatVersion: 1, kind: "user_input", turnId: t, message: { text: "u".repeat(20 + rand(400)) } },
      });
      const resultCount = rand(5);
      for (let r = 0; r < resultCount; r++) {
        const callId = `${idPrefix}-c${r}`;
        events.push({
          event_id: `${idPrefix}-a${r}`,
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
          event_id: `${idPrefix}-r${r}`,
          session_id: "s",
          timestamp: events.length + 1,
          kind: "canonical_message",
          actor: "kernel",
          payload: {
            formatVersion: 1,
            kind: "tool_result",
            turnId: t,
            message: { callId, toolName: "shell", text: "r".repeat(40 + rand(800)), isError: false },
          },
        });
      }
      events.push({
        event_id: `${idPrefix}-done`,
        session_id: "s",
        timestamp: events.length + 1,
        kind: "canonical_message",
        actor: "kernel",
        payload: { formatVersion: 1, kind: "assistant", turnId: t, message: { text: "a".repeat(20 + rand(200)) } },
      });
    }

    const windowTokens = 600 + rand(2400);
    const effectiveMaxTokens = 100 + rand(300);
    const tailTurns = rand(5);
    const stubKeepRecent = 1 + rand(3);
    const stubMinTokens = 50 + rand(150);
    const mode = rand(5); // 0..2: valid summary, 3: repairable once, 4: summary fails

    const stateGraph = new StateGraph();
    stateGraph.create("note", { text: "state note" });

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
        if (mode === 4) return summaryResp("invalid summary");
        if (mode === 3 && callCount % 2 === 1) return summaryResp("needs repair");
        return summaryResp(validSummary(`Scenario ${scenario}`));
      },
    });

    const turns = buildTurns(events);
    const inFlight = turns.at(-1)!;
    expect(inFlight.completed).toBe(false);

    const restored = restoreFrozenStateFromLog(mockLog);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw restored.error;

    if (outcome.status === "rewritten" || outcome.status === "stubbed") {
      expect(restored.state.generation).toBe(1);
      expect(outcome.state).toEqual(restored.state);
      expect(outcome.fill.fits).toBe(true);
      if (outcome.status === "rewritten") {
        expect(outcome.state.boundaryEventId).not.toBeNull();
        expect(outcome.state.summary).not.toBeNull();
      } else {
        expect(outcome.state.boundaryEventId).toBeNull();
        expect(outcome.state.summary).toBeNull();
      }
    } else if (outcome.status === "noop" || outcome.status === "unchanged_fits" || outcome.status === "summary_failed_fits") {
      expect(restored.state.generation).toBe(0);
      expect(outcome.fill.fits).toBe(true);
    } else if (outcome.status === "capacity_error") {
      expect(restored.state.generation).toBe(0);
    } else {
      throw new Error(`Unexpected status in scenario ${scenario}: ${outcome.status}`);
    }

    // Boundary invariant: never inside a turn and never includes the in-flight turn.
    if (restored.state.boundaryEventId !== null) {
      const cutIdx = turns.findIndex((t) => t.completed && t.eventIds.at(-1) === restored.state.boundaryEventId);
      expect(cutIdx).toBeGreaterThanOrEqual(0);
      expect(cutIdx).toBeLessThan(turns.length - 1);
      const foldedIds = new Set(turns.slice(0, cutIdx + 1).flatMap((t) => t.eventIds));
      for (const stub of restored.state.stubSet) {
        expect(foldedIds.has(stub.eventId)).toBe(false);
      }
    }

    // INV-1 check after appending a new complete record to the in-flight turn.
    const beforeMat = materializeHistory(restored.state, events);
    expect(beforeMat.ok).toBe(true);
    if (!beforeMat.ok) throw beforeMat.error;
    mockLog.append({
      kind: "canonical_message",
      actor: "kernel",
      payload: { formatVersion: 1, kind: "assistant", turnId: inFlight.turnId, message: { text: "appended step" } },
    });
    const afterMat = materializeHistory(restored.state, events);
    expect(afterMat.ok).toBe(true);
    if (!afterMat.ok) throw afterMat.error;
    expect(afterMat.messages.slice(0, beforeMat.messages.length)).toEqual(beforeMat.messages);
    expect(afterMat.messages.at(-1)).toEqual({ role: "assistant", content: "appended step" });
  }
});
