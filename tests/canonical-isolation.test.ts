import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, eventsAfterResetBoundary, findLastResetBoundaryIndex, findLastResetBoundaryTurn } from "../src/event-log.js";
import { compileClassicWithMetrics } from "../src/compile-classic.js";
import { maybeAutoCompactClassic } from "../src/auto-compact.js";
import { executeSlashCommand } from "../src/slash-commands.js";
import { formatRecentConversationLines } from "../src/app-banner.js";
import { computeMemoryStats } from "../src/turn.js";
import { Session } from "../src/session.js";
import { StateGraph } from "../src/state-graph.js";
import { loadConfig } from "../src/config.js";
import { CanonicalWriter, readFullSessionCanonicalRecords } from "../src/canonical-transcript.js";
import { findReplayStartIndex, loadStateGraphCheckpoint } from "../src/state-graph-checkpoint.js";
import { createMemoryTools } from "../src/tools/memory.js";

const roots: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  mock.restore();
  for (const log of logs.splice(0)) log.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "canonical-isolation-"));
  roots.push(root);
  const log = new EventLog("session", root);
  logs.push(log);
  return { log, root };
}
function noise(log: EventLog, count: number) {
  for (let i = 0; i < count; i++) log.append({ kind: "canonical_message", actor: "kernel", event_id: `canonical-${i}`, timestamp: 123, payload: { formatVersion: 1, kind: "user_input", turnId: i + 1, message: { text: "needle" } } });
}
function legacy(log: EventLog, id: string, kind: "user_message" | "agent_message" | "system_note" = "user_message", payload = { text: "needle" } as Record<string, unknown>) {
  log.append({ kind, actor: "kernel", event_id: id, timestamp: 123, payload });
}

test("default search excludes canonical matches before its limit break, including raw tool fallback", async () => {
  const { log } = setup();
  noise(log, 3);
  legacy(log, "legitimate");
  expect(log.search("needle", { limit: 1 }).map((m) => m.event.event_id)).toEqual(["legitimate"]);
  const tools = createMemoryTools({ eventLog: log, stateGraph: new StateGraph(), includeWorkingMemoryTools: false });
  const result = await tools.search_session_log.execute({ query: "needle", limit: 1 });
  expect(result).toMatchObject({ matchCount: 1, matches: [{ kind: "user_message" }] });
  expect(JSON.stringify(result)).not.toContain("canonical_message");
});

test("all bounded generic read paths filter before slicing while explicit canonical access is complete", () => {
  const { log } = setup();
  legacy(log, "legitimate");
  noise(log, 10);
  for (const result of [log.readLast(1), log.readLastUncompressed(1), log.readLastUncompressedAfterResetBoundary(1), log.readAll(), log.readAllUncompressed(), log.readAllAfterResetBoundary(), log.readAllUncompressedAfterResetBoundary()]) {
    expect(result.map((e) => e.event_id)).toEqual(["legitimate"]);
  }
  expect(log.getLastEvent()?.event_id).toBe("legitimate");
  const raw = log.readAll({ includeCanonical: true });
  expect(raw).toHaveLength(11);
  expect(readFullSessionCanonicalRecords(raw)).toHaveLength(10);
});

test("compaction selects identical event ids and counts before chunk selection", async () => {
  const { log } = setup();
  const config = loadConfig();
  config.compiler = { ...config.compiler, auto_compact_at: 0.75, auto_compact_clear_at: 0.55, compact_chunk_fraction: 0.5, reserved_output_tokens: 0 };
  const compressed = spyOn(log, "markEventsAsCompressed");
  const compressTurns = mock(async () => 2);
  const session = { config, eventLog: log, memoryEnabled: true, memoryStore: { compressTurns }, isCompactionArmed: () => false, setCompactionArmed() {}, getContextWindowTokens: () => 10000, debug: false } as unknown as Session;
  noise(log, 20);
  for (let i = 0; i < 6; i++) legacy(log, `legacy-${i}`, i % 2 ? "agent_message" : "user_message", { text: `message ${i}` });
  const result = await maybeAutoCompactClassic(session, 8000, "test/model");
  expect(result).toMatchObject({ compacted: true, eventsCompacted: 3, factsStored: 2 });
  expect(compressed).toHaveBeenCalledWith(["legacy-0", "legacy-1", "legacy-2"]);
  expect(compressTurns.mock.calls[0][0]).toEqual([
    { type: "user_message", timestamp: 123, content: "message 0" },
    { type: "agent_message", timestamp: 123, content: "message 1" },
    { type: "user_message", timestamp: 123, content: "message 2" },
  ]);
});

test("classic assembly excludes its trailing current input despite canonical copies", () => {
  const { log } = setup();
  legacy(log, "previous", "agent_message", { text: "older reply" });
  legacy(log, "current", "user_message", { text: "current unique input" });
  noise(log, 30);
  const result = compileClassicWithMetrics({ cwd: "/project", sessionId: "session", toolSchemas: [], events: log.readAllUncompressed(), userInput: "current unique input" });
  expect(result.prompt).toContain("older reply");
  expect(result.prompt).not.toContain("current unique input");
  expect(result.prompt).not.toContain("needle");
});

test("events command keeps the same twenty-event window", async () => {
  const { log } = setup();
  for (let i = 0; i < 20; i++) legacy(log, `legacy-${i}`, "user_message", { text: `message ${i}` });
  const session = { eventLog: log } as Session;
  const handlers = { setModel() {}, setThinking() {}, getThinking: () => false };
  const baseline = await executeSlashCommand("/events", session, handlers);
  noise(log, 20);
  const isolated = await executeSlashCommand("/events", session, handlers);
  expect(isolated).toEqual(baseline);
  expect(JSON.stringify(isolated)).toContain("message 0");
  expect(JSON.stringify(isolated)).not.toContain("canonical_message");
});

test("recent banner finds the legitimate message outside a canonical-filled scan window", () => {
  const { log } = setup();
  legacy(log, "legitimate", "user_message", { text: "visible conversation" });
  const session = { eventLog: log } as Session;
  const baseline = formatRecentConversationLines(session, 1);
  noise(log, 30);
  expect(formatRecentConversationLines(session, 1)).toEqual(baseline);
  expect(baseline.join("\n")).toContain("visible conversation");
});

test("memory statistics find legitimate recalls outside a canonical-filled fifty-event window", () => {
  const { log } = setup();
  legacy(log, "recall", "system_note", { type: "memory_recall", hits: 7 });
  const session = { eventLog: log, getMemoryStats: () => ({ active: 0, total: 0 }), digest: null } as unknown as Session;
  const baseline = computeMemoryStats(session, 0);
  noise(log, 50);
  expect(computeMemoryStats(session, 0)).toEqual(baseline);
  expect(baseline).toMatchObject({ recallCalls: 1, recallHits: 7 });
});

test("checkpoint resume resolves a canonical event id without exposing its payload to generic readers", async () => {
  const { log, root } = setup();
  log.close();
  const config = loadConfig();
  config.session.log_dir = root;
  config.memory.enabled = false;
  config.memory.summarizer = "disabled";
  config.context_engine!.enabled = false;
  config.native = { ...config.native!, enabled: false };
  config.skills.enabled = false;
  config.project_detection!.enabled = false;
  const session = Session.createNew("session", root, config);
  logs.push(session.eventLog);
  const task = session.stateGraph.create("task", { title: "checkpoint task" });
  await new CanonicalWriter(session.eventLog, (error) => { throw error; }).startTurn("input");
  expect(session.eventLog.readAll()).toHaveLength(0);
  session.incrementTurn();
  session.persistStateGraphCheckpoint();
  const checkpoint = loadStateGraphCheckpoint(join(root, "session"))!;
  expect(checkpoint.last_event_id).toBe(session.eventLog.getLastEvent({ includeCanonical: true })!.event_id);
  expect(findReplayStartIndex(session.eventLog.readAll({ includeCanonical: true }), checkpoint.last_event_id)).toBe(1);
  session.eventLog.append({ kind: "context_action", actor: "kernel", payload: { action: "update", id: task.id, statePayload: { title: "after anchor" }, updated: Date.now() } });
  session.eventLog.close();
  const resumed = await Session.resume(session.id, root, config, { suppressLoggerStderr: true });
  logs.push(resumed.eventLog);
  expect(resumed.stateGraph.get(task.id)?.payload.title).toBe("after anchor");
  expect(resumed.getTurnCount()).toBe(1);
});

test("reset boundary indices are resolved within each view and turn counts do not count canonical inputs", () => {
  const { log } = setup();
  legacy(log, "old");
  noise(log, 3);
  log.logResetBoundary("/clear");
  legacy(log, "new");
  const visible = log.readAll();
  expect(visible.some((e) => e.kind === "canonical_message")).toBe(false);
  const raw = log.readAll({ includeCanonical: true });
  for (const events of [visible, raw]) {
    expect(findLastResetBoundaryTurn(events)).toBe(0);
    expect(events[findLastResetBoundaryIndex(events)].payload.type).toBe("reset_boundary");
    expect(eventsAfterResetBoundary(events).map((e) => e.event_id)).toEqual(["new"]);
  }
});
