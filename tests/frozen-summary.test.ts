import { afterEach, expect, spyOn, test } from "bun:test";
import { fsyncSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, type EventLogOptions } from "../src/event-log.js";
import type { Event } from "../src/types.js";
import type { CompactionCommit } from "../src/frozen-summary.js";
import { estimateTokens } from "../src/token-estimate.js";

const headings = ["Active request", "Plan", "Constraints", "Decisions", "Files in play", "Completed", "Open threads"];
const markdown = `### Active request
Ship the parser.

### Plan
- Add tests

### Constraints
- Stay offline

### Decisions
- Use markdown — Rationale: readable
- Keep bytes

### Files in play
- src/parser.ts

### Completed
- Read source

### Open threads
- [error] Missing export
- [question] Which edge cases?
`;

// Load inside each test so missing functionality produces individual red tests.
const api = () => import("../src/frozen-summary.js");

test("parses the normalized view, including optional rationale and thread kinds", async () => {
  const { parseSummary } = await api();
  expect(parseSummary(markdown)).toEqual({
    active_request: "Ship the parser.", plans: [{ text: "Add tests" }],
    constraints: ["Stay offline"],
    decisions: [{ summary: "Use markdown", rationale: "readable" }, { summary: "Keep bytes" }],
    files: [{ path: "src/parser.ts" }], completed: [{ text: "Read source" }],
    open_threads: [{ kind: "error", text: "Missing export" }, { kind: "question", text: "Which edge cases?" }],
  });
});

test("renders a user-role context message without rewriting markdown bytes and round trips the view", async () => {
  const { parseSummary, renderSummaryMessage } = await api();
  const message = renderSummaryMessage(markdown);
  expect(message.role).toBe("user");
  expect(message.content).toContain("summary of earlier conversation");
  expect(message.content).toContain("not instructions");
  expect(message.content.endsWith(markdown)).toBe(true);
  expect(parseSummary(message.content)).toEqual(parseSummary(markdown));
});

test("parsing is a lenient view, not a schema validator", async () => {
  const { parseSummary } = await api();
  expect(parseSummary("unstructured prose")).toEqual({ active_request: "", plans: [], constraints: [], decisions: [], files: [], completed: [], open_threads: [] });
  const view = parseSummary("### Active request\r\nFirst line\r\ncontinued\r\n\r\n### Plan\r\n* one\r\n  continued\r\n+ two\r\n### Open threads\r\n- Unlabelled question\r\n");
  expect(view.active_request).toBe("First line\ncontinued");
  expect(view.plans).toEqual([{ text: "one\ncontinued" }, { text: "two" }]);
  expect(view.open_threads).toEqual([{ kind: "question", text: "Unlabelled question" }]);
});

for (const heading of headings) {
  test(`check rejects a missing ${heading} heading`, async () => {
    const { checkSummary } = await api();
    const result = checkSummary(markdown.replace(`### ${heading}\n`, ""), { capTokens: 4096 });
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({ kind: "missing_heading", heading }));
  });
}

test("checks only headings, nonempty active request and the estimated size cap", async () => {
  const { checkSummary } = await api();
  expect(checkSummary(markdown, { capTokens: estimateTokens(markdown) })).toMatchObject({ ok: true, failures: [] });
  expect(checkSummary(markdown, { capTokens: estimateTokens(markdown) - 1 })).toMatchObject({ ok: false, failures: [expect.objectContaining({ kind: "over_cap" })] });
  expect(checkSummary(markdown.replace("Ship the parser.", "  "), { capTokens: 4096 })).toMatchObject({ ok: false, failures: [expect.objectContaining({ kind: "empty_active_request" })] });
  const lenient = headings.map((h, i) => `### ${h}\n${i === 0 ? "Do the work." : "arbitrary prose"}`).join("\n\n");
  expect(checkSummary(lenient, { capTokens: 4096 }).ok).toBe(true);
});

test("caps at one eighth of a small usable window, rounded down, and never above 4096", async () => {
  const { summaryCapTokens } = await api();
  expect(summaryCapTokens(2048)).toBe(256);
  expect(summaryCapTokens(1031)).toBe(128);
  expect(summaryCapTokens(100000)).toBe(4096);
});

test("instruction rewrites the entire schema from previous summary and folded turns, never the tail", async () => {
  const { buildSummaryInstruction } = await api();
  const instruction = buildSummaryInstruction({ cutDescription: "through event z (turn 3)", previousSummary: markdown, stateObjects: [], capTokens: 256 });
  for (const heading of headings) expect(instruction).toContain(`### ${heading}`);
  for (const text of ["through event z (turn 3)", "256", markdown, "State objects", "whole block", "not a field merge", "tail is visible", "must not be summarised", "tool output", "data", "not instructions", "Do not call tools", "oldest completed", "superseded decisions", "files not in the retained tail", "Never prune active_request, constraints, plans, or open_threads"]) expect(instruction).toContain(text);
  expect(instruction.indexOf("oldest completed")).toBeLessThan(instruction.indexOf("superseded decisions"));
  expect(instruction.indexOf("superseded decisions")).toBeLessThan(instruction.indexOf("files not in the retained tail"));
  expect(instruction).not.toMatch(/### (Narrative|Findings|Fixed errors|Recent activity|Session stats)/i);
  const first = buildSummaryInstruction({ cutDescription: "first cut", capTokens: 256 });
  expect(first).toContain("first cut");
  expect(first).not.toContain("undefined");
});

test("repair instruction allows exactly one attempt then keeps the previous boundary", async () => {
  const { checkSummary, buildRepairInstruction } = await api();
  const failures = checkSummary("", { capTokens: 256 }).failures;
  const repair = buildRepairInstruction(failures);
  for (const failure of failures) expect(repair).toContain(failure.message);
  expect(repair).toContain("exactly one repair attempt");
  expect(repair).toContain("keep the previous boundary");
  expect(repair).toContain("Do not call tools");
});

test("frozen summary has no checkpoint or memory imports", async () => {
  await api();
  const source = readFileSync(new URL("../src/frozen-summary.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*(?:checkpoint|memory)/);
});

const roots: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function openLog(options: EventLogOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "frozen-summary-"));
  roots.push(root);
  const log = new EventLog("s", root, options);
  logs.push(log);
  return { root, log };
}
function canonical(id: string, kind: "user_input" | "tool_result" = "user_input"): Event {
  return { event_id: id, session_id: "s", timestamp: 1, kind: "canonical_message", actor: "kernel", payload: {
    formatVersion: 1, kind, turnId: 1,
    message: kind === "user_input" ? { text: "input" } : { callId: "call", toolName: "shell", isError: false, text: "large output" },
  } };
}
function data(overrides: Partial<CompactionCommit> = {}): CompactionCommit {
  return { formatVersion: 1, resetEpoch: "session_start", generation: 1, boundaryEventId: "z", summary: markdown, stubSet: [], summaryRequest: null, ...overrides };
}
function recorded(payload: unknown, id = "commit"): Event {
  return { event_id: id, session_id: "s", timestamp: 1, kind: "compaction_commit" as Event["kind"], actor: "kernel", payload: payload as Record<string, unknown> };
}
function reset(id: string): Event {
  return { event_id: id, session_id: "s", timestamp: 1, kind: "system_note", actor: "kernel", payload: { type: "reset_boundary", command: "/clear" } };
}

test("builds one kernel commit event and reads its exact summary, stubs and request bytes", async () => {
  const { buildCommitEvent, readCommits, SESSION_START_EPOCH } = await api();
  expect(SESSION_START_EPOCH).toBe("session_start");
  const commit = data({ stubSet: [{ eventId: "a", stubText: "stub\n雪" }], summaryRequest: { instruction: "instruction\n", usage: { input: 10, output: 2, totalTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 1 } } });
  expect(buildCommitEvent(commit)).toEqual({ kind: "compaction_commit", actor: "kernel", payload: commit });
  expect(readCommits([canonical("z"), recorded(commit)])).toEqual([commit]);
});

test("restores a valid empty state without commits", async () => {
  const { restoreFrozenState } = await api();
  expect(restoreFrozenState([])).toEqual({ ok: true, state: { resetEpoch: "session_start", generation: 0, boundaryEventId: null, summary: null, stubSet: [], summaryRequest: null } });
});

test("restores successive commits by log position, not lexicographic id order", async () => {
  const { restoreFrozenState } = await api();
  const second = data({ generation: 2, boundaryEventId: "a", summary: markdown + "\n" });
  const result = restoreFrozenState([canonical("z"), recorded(data(), "zz"), canonical("a"), recorded(second, "aa")]);
  expect(result).toMatchObject({ ok: true, state: { generation: 2, boundaryEventId: "a", summary: second.summary } });
});

const malformed: [string, unknown, string][] = [
  ["non-object", null, "invalid_commit"],
  ["wrong version", data({ formatVersion: 2 as 1 }), "unsupported_version"],
  ["missing field", { ...data(), stubSet: undefined }, "invalid_commit"],
  ["extra field", { ...data(), surprise: true }, "invalid_commit"],
  ["invalid generation", data({ generation: 1.5 }), "invalid_commit"],
  ["empty epoch", data({ resetEpoch: "" }), "invalid_commit"],
  ["invalid summary", data({ summary: 7 as unknown as string }), "invalid_commit"],
  ["mismatched null boundary", data({ boundaryEventId: null }), "invalid_commit"],
  ["invalid stub text", { ...data(), stubSet: [{ eventId: "a", stubText: 7 }] }, "invalid_commit"],
  ["duplicate stubs", data({ stubSet: [{ eventId: "a", stubText: "x" }, { eventId: "a", stubText: "y" }] }), "invalid_commit"],
  ["sparse stubs", data({ stubSet: new Array(1) }), "invalid_commit"],
  ["invalid usage", { ...data(), summaryRequest: { instruction: "x", usage: { input: -1, output: 1, totalTokens: 0 } } }, "invalid_commit"],
  ["non-finite usage", { ...data(), summaryRequest: { instruction: "x", usage: { input: 1, output: NaN, totalTokens: 1 } } }, "invalid_commit"],
  ["unknown usage field", { ...data(), summaryRequest: { instruction: "x", usage: { input: 1, output: 1, totalTokens: 2, extra: 1 } } }, "invalid_commit"],
  ["missing instruction", { ...data(), summaryRequest: { usage: null } }, "invalid_commit"],
  ["undefined prefix", { ...data(), prefix: undefined }, "invalid_commit"],
  ["invalid prefix", { ...data(), prefix: { systemFrame: "bytes", snapshot: 1 } }, "invalid_commit"],
  ["extra prefix field", { ...data(), prefix: { systemFrame: "bytes", snapshot: "bytes", extra: true } }, "invalid_commit"],
];
for (const [name, payload, code] of malformed) {
  test(`commit validation rejects ${name} with a typed error, never skipping corruption`, async () => {
    const { restoreFrozenState, readCommits, FrozenSummaryError } = await api();
    const events = [canonical("z"), recorded(payload)];
    const result = restoreFrozenState(events);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected malformed commit");
    expect(result.error).toBeInstanceOf(FrozenSummaryError);
    expect(result.error.code).toBe(code);
    expect(result.error.eventIndex).toBe(1);
    expect(() => readCommits(events)).toThrow(FrozenSummaryError);
  });
}

test("builder validates shape before constructing an event", async () => {
  const { buildCommitEvent, FrozenSummaryError } = await api();
  expect(typeof buildCommitEvent).toBe("function");
  expect(typeof FrozenSummaryError).toBe("function");
  expect(() => buildCommitEvent(data({ generation: 0 }))).toThrow(FrozenSummaryError);
});

const invalidSequences: [string, Event[], string][] = [
  ["generation starts at two", [canonical("z"), recorded(data({ generation: 2 }))], "invalid_generation"],
  ["generation gap", [canonical("z"), recorded(data()), recorded(data({ generation: 3, summary: markdown + "\n" }))], "invalid_generation"],
  ["repeated generation", [canonical("z"), recorded(data()), recorded(data({ summary: markdown + "\n" }))], "invalid_generation"],
  ["boundary regression", [canonical("a"), canonical("z"), recorded(data()), recorded(data({ generation: 2, boundaryEventId: "a" }))], "boundary_regression"],
  ["dangling boundary", [recorded(data())], "invalid_boundary"],
  ["future boundary", [recorded(data()), canonical("z")], "invalid_boundary"],
  ["noncanonical boundary", [{ ...canonical("z"), kind: "user_message" }, recorded(data())], "invalid_boundary"],
  ["boundary outside epoch", [canonical("z"), reset("reset"), recorded(data({ resetEpoch: "reset" }))], "invalid_boundary"],
  ["wrong epoch", [reset("reset"), canonical("z"), recorded(data())], "invalid_epoch"],
  ["dangling stub", [canonical("z"), recorded(data({ stubSet: [{ eventId: "missing", stubText: "x" }] }))], "invalid_stub"],
  ["stub references input", [canonical("z"), recorded(data({ stubSet: [{ eventId: "z", stubText: "x" }] }))], "invalid_stub"],
  ["stub outside epoch", [canonical("a", "tool_result"), reset("reset"), canonical("z"), recorded(data({ resetEpoch: "reset", stubSet: [{ eventId: "a", stubText: "x" }] }))], "invalid_stub"],
  ["unchanged generation bump", [canonical("z"), recorded(data()), recorded(data({ generation: 2 }))], "unchanged_commit"],
  ["empty first commit", [recorded(data({ summary: null, boundaryEventId: null }))], "unchanged_commit"],
];
for (const [name, events, code] of invalidSequences) {
  test(`restore rejects ${name}`, async () => {
    const { restoreFrozenState, FrozenSummaryError } = await api();
    const result = restoreFrozenState(events);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid sequence");
    expect(result.error).toBeInstanceOf(FrozenSummaryError);
    expect(result.error.code).toBe(code);
  });
}

test("stubs-only commits keep the summary and boundary, replacing the whole stub set", async () => {
  const { restoreFrozenState } = await api();
  const second = data({ generation: 2, stubSet: [{ eventId: "a", stubText: "fixed bytes" }] });
  expect(restoreFrozenState([canonical("z"), canonical("a", "tool_result"), recorded(data()), recorded(second)])).toMatchObject({ ok: true, state: { generation: 2, summary: markdown, boundaryEventId: "z", stubSet: second.stubSet } });
});

test("first-turn stubs-only commit has null summary and boundary", async () => {
  const { restoreFrozenState } = await api();
  const commit = data({ summary: null, boundaryEventId: null, stubSet: [{ eventId: "a", stubText: "stub" }] });
  expect(restoreFrozenState([canonical("z"), canonical("a", "tool_result"), recorded(commit)])).toMatchObject({ ok: true, state: { generation: 1, summary: null, boundaryEventId: null, stubSet: commit.stubSet } });
});

test("null boundary cannot replace a previously absorbed boundary", async () => {
  const { restoreFrozenState } = await api();
  expect(restoreFrozenState([canonical("z"), recorded(data()), recorded(data({ generation: 2, summary: null, boundaryEventId: null }))])).toMatchObject({ ok: false, error: { code: "boundary_regression" } });
});

test("reserved prefix is optional and validated on restore, but never written by the builder", async () => {
  const { restoreFrozenState, buildCommitEvent } = await api();
  const prefix = { systemFrame: "system\n雪", snapshot: "snapshot\n" };
  expect(restoreFrozenState([canonical("z"), recorded(data({ prefix }))])).toMatchObject({ ok: true, state: { prefix } });
  expect(buildCommitEvent(data()).payload).not.toHaveProperty("prefix");
  expect(() => buildCommitEvent(data({ prefix }))).toThrow("reserved prefix");
});

test("clear hides old state, restarts generation, and does not resurrect a pre-clear summary", async () => {
  const { restoreFrozenState } = await api();
  const before = [canonical("z"), recorded(data()), reset("reset-z")];
  expect(restoreFrozenState(before)).toEqual({ ok: true, state: { resetEpoch: "reset-z", generation: 0, boundaryEventId: null, summary: null, stubSet: [], summaryRequest: null } });
  const next = data({ resetEpoch: "reset-z", boundaryEventId: "a", summary: markdown.replace("Ship the parser.", "New request.") });
  expect(restoreFrozenState([...before, canonical("a"), recorded(next)])).toMatchObject({ ok: true, state: { resetEpoch: "reset-z", generation: 1, summary: next.summary } });
});

test("corrupt commits are not silently skipped even before a later reset", async () => {
  const { restoreFrozenState } = await api();
  expect(restoreFrozenState([recorded({}), reset("reset")])).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
});

test("append helper writes exactly one event, without canonical instruction or response records", async () => {
  const { appendCommit, restoreFrozenState } = await api();
  const { log } = openLog();
  log.append(canonical("z"));
  const append = spyOn(log, "append");
  try {
    expect(appendCommit(log, data())).toEqual({ status: "committed" });
    expect(append).toHaveBeenCalledTimes(1);
  } finally { append.mockRestore(); }
  const events = log.readAll({ includeCanonical: true });
  expect(events.map(e => e.kind)).toEqual(["canonical_message", "compaction_commit"]);
  expect(readFileSync(log.getLogPath(), "utf8").trimEnd().split("\n")).toHaveLength(2);
  expect(restoreFrozenState(events)).toMatchObject({ ok: true, state: { generation: 1 } });
});

test("torn commit append is uncertain; reopen restores the prior commit and separates the next append", async () => {
  const { appendCommit, restoreFrozenState } = await api();
  let tearing = false;
  let writes = 0;
  const failure = new Error("torn write");
  const { root, log } = openLog({ onCorruptLine: () => {}, write: (fd, buffer, offset, length) => {
    if (tearing) {
      writes++;
      if (writes === 1) return writeSync(fd, buffer, offset, 30);
      throw failure;
    }
    return writeSync(fd, buffer, offset, length);
  } });
  log.append(canonical("z"));
  expect(appendCommit(log, data())).toEqual({ status: "committed" });
  tearing = true;
  const second = data({ generation: 2, summary: markdown + "\n" });
  expect(appendCommit(log, second)).toEqual({ status: "commit_uncertain", error: failure });
  expect(writes).toBe(2);
  expect(restoreFrozenState(log.readAll({ includeCanonical: true }))).toMatchObject({ ok: true, state: { generation: 1 } });
  log.close();
  const reopened = new EventLog("s", root, { onCorruptLine: () => {} });
  logs.push(reopened);
  expect(reopened.corruptLineCount).toBe(1);
  expect(restoreFrozenState(reopened.readAll({ includeCanonical: true }))).toMatchObject({ ok: true, state: { generation: 1 } });
  expect(appendCommit(reopened, second)).toEqual({ status: "committed" });
  reopened.close();
  const again = new EventLog("s", root, { onCorruptLine: () => {} });
  logs.push(again);
  expect(again.corruptLineCount).toBe(1);
  expect(restoreFrozenState(again.readAll({ includeCanonical: true }))).toMatchObject({ ok: true, state: { generation: 2, summary: second.summary } });
});

test("failed fsync is uncertain even when the commit is durable; reopen restores it exactly once", async () => {
  const { appendCommit, restoreFrozenState, readCommits } = await api();
  let failSync = false;
  let syncs = 0;
  const failure = new Error("failed fsync");
  const { root, log } = openLog({ fsync: fd => {
    fsyncSync(fd);
    if (failSync) { syncs++; throw failure; }
  } });
  log.append(canonical("z"));
  failSync = true;
  expect(appendCommit(log, data())).toEqual({ status: "commit_uncertain", error: failure });
  expect(syncs).toBe(1);
  expect(restoreFrozenState(log.readAll({ includeCanonical: true }))).toMatchObject({ ok: true, state: { generation: 1 } });
  log.close();
  const reopened = new EventLog("s", root);
  logs.push(reopened);
  expect(reopened.corruptLineCount).toBe(0);
  expect(readCommits(reopened.readAll({ includeCanonical: true }))).toHaveLength(1);
  expect(restoreFrozenState(reopened.readAll({ includeCanonical: true }))).toMatchObject({ ok: true, state: { generation: 1, summary: markdown } });
});
