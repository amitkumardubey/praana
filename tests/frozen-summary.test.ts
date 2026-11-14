import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { fsyncSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { EventLog, eventsAfterResetBoundary, findLastResetBoundaryIndex, findLastResetBoundaryTurn, type EventLogOptions } from "../src/event-log.js";
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

const requestData = { cutDescription: "through event z", capTokens: 4096, instructionSha256: createHash("sha256").update("instruction\n").digest("hex") };

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

test("numbered items and nested bullets form top-level list items", async () => {
  const { parseSummary } = await api();
  expect(parseSummary("### Plan\n1. first\n  - nested\n2) second\n    1. detail\n").plans).toEqual([{ text: "first\n- nested" }, { text: "second\n1. detail" }]);
});

test("fenced headings are ignored and duplicate required headings fail", async () => {
  const { checkSummary, parseSummary } = await api();
  for (const fence of ["```", "~~~"]) {
    const text = markdown.replace("Ship the parser.", `Ship the parser.\n${fence}\n### Plan\nnot a section\n${fence}`);
    expect(checkSummary(text, { capTokens: 4096 }).ok).toBe(true);
    expect(parseSummary(text).active_request).toContain("### Plan");
    expect(checkSummary(markdown.replace("### Plan\n", `${fence}\n### Plan\n${fence}\n`), { capTokens: 4096 }).failures).toContainEqual(expect.objectContaining({ kind: "missing_heading", heading: "Plan" }));
  }
  expect(checkSummary(markdown + "\n### Plan\n- duplicate", { capTokens: 4096 }).failures).toContainEqual(expect.objectContaining({ kind: "duplicate_heading", heading: "Plan" }));
  const reordered = headings.slice().reverse().map(h => `### ${h}\n${h === "Active request" ? "work" : ""}`).join("\n");
  expect(checkSummary(reordered, { capTokens: 4096 }).ok).toBe(true);
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

test("minimumValidSummary passes validation with filler under the first heading", async () => {
  const { minimumValidSummary, checkSummary, parseSummary } = await api();
  expect(minimumValidSummary).toBeFunction();
  const text = minimumValidSummary();
  expect(text).toBe(headings.map((heading, index) => `### ${heading}${index === 0 ? "\nok" : ""}`).join("\n\n"));
  expect(parseSummary(text)).toEqual({
    active_request: "ok", plans: [], constraints: [], decisions: [], files: [], completed: [], open_threads: [],
  });
  expect(checkSummary(text, { capTokens: estimateTokens(text) })).toEqual({ ok: true, failures: [], estimatedTokens: estimateTokens(text) });
  expect(checkSummary(text, { capTokens: estimateTokens(text) - 1 }).ok).toBe(false);
});

test("caps at one eighth of a small usable window, rounded down, and never above 4096", async () => {
  const { summaryCapTokens } = await api();
  expect(summaryCapTokens(2048)).toBe(256);
  expect(summaryCapTokens(1031)).toBe(128);
  expect(summaryCapTokens(100000)).toBe(4096);
});

test("invalid usable windows have zero summary capacity", async () => {
  const { summaryCapTokens } = await api();
  for (const value of [NaN, Infinity, -Infinity, -1, 0]) expect(summaryCapTokens(value)).toBe(0);
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
  expect(first).toContain("retained tail is visible");
  expect(first).not.toContain("undefined");
  const standalone = buildSummaryInstruction({ cutDescription: "standalone cut", capTokens: 256, tailVisible: false });
  expect(standalone).toContain("contains only the conversation to summarise");
  expect(standalone).not.toContain("retained tail is visible");
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
  mock.restore();
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
  const summary = overrides.summary === undefined ? markdown : overrides.summary;
  return { formatVersion: 1, resetEpoch: "session_start", generation: 1, boundaryEventId: "z", summary, stubSet: [], summaryRequest: summary === null ? null : { ...requestData, usage: null }, ...overrides };
}
const commitKind: Event["kind"] = "compaction_commit";
function recorded(payload: unknown, id = "commit"): Event {
  return { event_id: id, session_id: "s", timestamp: 1, kind: commitKind, actor: "kernel", payload: payload as Record<string, unknown> };
}
function reset(id: string): Event {
  return { event_id: id, session_id: "s", timestamp: 1, kind: "system_note", actor: "kernel", payload: { type: "reset_boundary", command: "/clear" } };
}

test("builds one kernel commit event and reads its exact summary, stubs and request bytes", async () => {
  const { buildCommitEvent, readCommits, SESSION_START_EPOCH } = await api();
  expect(SESSION_START_EPOCH).toBe("session_start");
  const commit = data({ stubSet: [{ eventId: "a", stubText: "stub\n雪" }], summaryRequest: { ...requestData, usage: { input: 10, output: 2, totalTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 1 } } });
  expect(buildCommitEvent(commit)).toEqual({ kind: "compaction_commit", actor: "kernel", payload: commit });
  expect(readCommits([canonical("z"), recorded(commit)])).toEqual([commit]);
});

test("commit request stores cut, cap and instruction hash without instruction inputs", async () => {
  const { buildSummaryInstruction, buildCommitEvent, readCommits, appendCommit, restoreFrozenStateFromLog } = await api();
  const state = new StateGraph().create("note", { text: "private state text" });
  const options = { cutDescription: "through event z", capTokens: 256, previousSummary: "private previous summary", stateObjects: [state] };
  const instruction = buildSummaryInstruction(options);
  const request = { cutDescription: options.cutDescription, capTokens: options.capTokens, instructionSha256: createHash("sha256").update(instruction).digest("hex"), usage: null };
  const commit = data({ summaryRequest: request });
  expect(buildCommitEvent(commit).payload.summaryRequest).toEqual(request);
  expect(readCommits([recorded(commit)])[0].summaryRequest).toEqual(request);
  const { log } = openLog();
  log.append(canonical("z"));
  expect(appendCommit(log, commit)).toEqual({ status: "committed" });
  expect(restoreFrozenStateFromLog(log)).toMatchObject({ ok: true, state: { summaryRequest: request } });
  const stored = readFileSync(log.getLogPath(), "utf8");
  for (const text of [instruction, "private state text", "private previous summary"]) expect(stored).not.toContain(text);
  expect(Object.keys((readCommits(log.readAll({ includeInternal: true }))[0].summaryRequest)!)).toEqual(["cutDescription", "capTokens", "instructionSha256", "usage"]);
});

const usageCases: [string, unknown, unknown][] = [
  ["extra key", { input: 1, output: 2, totalTokens: 3, extra: 99 }, { input: 1, output: 2, totalTokens: 3 }],
  ["explicit undefined", { input: 1, cacheReadTokens: undefined }, { input: 1 }],
  ["fractional", { input: 1.9, output: 2.8, totalTokens: 4.7, cacheReadTokens: 0.9, cacheWriteTokens: 3.2 }, { input: 1, output: 2, totalTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 3 }],
  ["negative", { input: -1, output: 0, cacheReadTokens: -0.5 }, { output: 0 }],
  ["NaN and infinity", { input: NaN, output: Infinity, totalTokens: -Infinity }, null],
  ["future optional field", { input: 4, reasoningTokens: 20 }, { input: 4 }],
  ["empty", {}, null],
  ["undefined", undefined, null],
  ["non-object", "usage", null],
  ["array", [1, 2], null],
  ["non-plain object", new Date(0), null],
  ["null prototype", Object.assign(Object.create(null), { cacheWriteTokens: 2.9 }), { cacheWriteTokens: 2 }],
  ["symbol extra key", { input: 5, [Symbol("future")]: 2 }, { input: 5 }],
  ["invalid fields", { input: "1", output: null, totalTokens: false }, null],
  ["large finite count", { input: 1e100 }, null],
  ["unsafe integer", { input: Number.MAX_SAFE_INTEGER + 1 }, null],
  ["mixed unsafe and safe counts", { input: 1e100, output: 2.9, totalTokens: Number.MAX_SAFE_INTEGER }, { output: 2, totalTokens: Number.MAX_SAFE_INTEGER }],
];
for (const [name, usage, expected] of usageCases) {
  test(`usage is informational during build, read, replay and append: ${name}`, async () => {
    const { buildCommitEvent, readCommits, restoreFrozenState, appendCommit, restoreFrozenStateFromLog } = await api();
    const commit = data({ summaryRequest: { ...requestData, usage } as CompactionCommit["summaryRequest"] });
    expect((buildCommitEvent(commit).payload.summaryRequest as { usage: unknown }).usage).toEqual(expected);
    expect(readCommits([recorded(commit)])[0].summaryRequest?.usage).toEqual(expected);
    expect(restoreFrozenState([canonical("z"), recorded(commit)])).toMatchObject({ ok: true, state: { summaryRequest: { usage: expected } } });
    const { root, log } = openLog();
    log.append(canonical("z"));
    expect(appendCommit(log, commit)).toEqual({ status: "committed" });
    log.close();
    const reopened = new EventLog("s", root);
    logs.push(reopened);
    expect(restoreFrozenStateFromLog(reopened)).toMatchObject({ ok: true, state: { summaryRequest: { usage: expected } } });
  });
}

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
  ["legacy instruction", { ...data(), summaryRequest: { instruction: "private input", usage: null } }, "invalid_commit"],
  ["missing request metadata", { ...data(), summaryRequest: { usage: null } }, "invalid_commit"],
  ["invalid cut description", { ...data(), summaryRequest: { ...requestData, cutDescription: 7, usage: null } }, "invalid_commit"],
  ["invalid request cap", { ...data(), summaryRequest: { ...requestData, capTokens: -1, usage: null } }, "invalid_commit"],
  ["fractional request cap", { ...data(), summaryRequest: { ...requestData, capTokens: 1.5, usage: null } }, "invalid_commit"],
  ["invalid instruction hash", { ...data(), summaryRequest: { ...requestData, instructionSha256: "not a digest", usage: null } }, "invalid_commit"],
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

test("request pairing rejects a null summary with request metadata in builder and validator", async () => {
  const { buildCommitEvent, readCommits, restoreFrozenState, FrozenSummaryError } = await api();
  const commit = data({ summary: null, boundaryEventId: null, stubSet: [{ eventId: "a", stubText: "stub" }], summaryRequest: { ...requestData, usage: null } });
  expect(() => buildCommitEvent(commit)).toThrow(FrozenSummaryError);
  expect(() => readCommits([recorded(commit)])).toThrow(FrozenSummaryError);
  expect(restoreFrozenState([canonical("a", "tool_result"), recorded(commit)])).toMatchObject({ ok: false, error: { code: "invalid_commit" } });
});

test("identical summary bytes with an advancing boundary require a request in replay and append", async () => {
  const { restoreFrozenState, appendCommit, restoreFrozenStateFromLog } = await api();
  const events = [canonical("z"), recorded(data()), canonical("a")];
  const rewrite = data({ generation: 2, boundaryEventId: "a" });
  expect(restoreFrozenState([...events, recorded(rewrite)])).toMatchObject({ ok: true, state: { generation: 2, boundaryEventId: "a", summary: markdown } });
  const { log } = openLog();
  for (const event of events) log.append(event);
  const before = readFileSync(log.getLogPath(), "utf8");
  expect(restoreFrozenState([...events, recorded({ ...rewrite, summaryRequest: null })])).toMatchObject({ ok: false, error: { code: "invalid_commit" } });
  expect(appendCommit(log, { ...rewrite, summaryRequest: null })).toMatchObject({ status: "rejected", error: { code: "invalid_commit" } });
  expect(readFileSync(log.getLogPath(), "utf8")).toBe(before);
  expect(appendCommit(log, rewrite)).toEqual({ status: "committed" });
  expect(restoreFrozenStateFromLog(log)).toMatchObject({ ok: true, state: { generation: 2, boundaryEventId: "a", summary: markdown } });
});

test("advancing the boundary without changing summary bytes rejects a missing request before append", async () => {
  const { restoreFrozenState, appendCommit } = await api();
  const events = [canonical("z"), recorded(data()), canonical("a")];
  const rewrite = data({ generation: 2, boundaryEventId: "a", summaryRequest: null });
  expect(restoreFrozenState([...events, recorded(rewrite)])).toMatchObject({ ok: false, error: { code: "invalid_commit" } });
  const { log } = openLog();
  for (const event of events) log.append(event);
  const before = readFileSync(log.getLogPath(), "utf8");
  expect(appendCommit(log, rewrite)).toMatchObject({ status: "rejected", error: { code: "invalid_commit" } });
  expect(readFileSync(log.getLogPath(), "utf8")).toBe(before);
});

test("request pairing requires metadata for every new summary rewrite", async () => {
  const { restoreFrozenState } = await api();
  const initial = data({ summaryRequest: { ...requestData, usage: null } });
  expect(restoreFrozenState([canonical("z"), recorded(data({ summaryRequest: null }))])).toMatchObject({ ok: false, error: { code: "invalid_commit" } });
  expect(restoreFrozenState([canonical("z"), recorded(initial), recorded(data({ generation: 2, summary: markdown + "\n", summaryRequest: null }))])).toMatchObject({ ok: false, error: { code: "invalid_commit" } });
});

test("request pairing forbids metadata for stubs-only commits with an unchanged summary", async () => {
  const { restoreFrozenState } = await api();
  const initial = data({ summaryRequest: { ...requestData, usage: null } });
  const second = data({ generation: 2, stubSet: [{ eventId: "a", stubText: "stub" }], summaryRequest: { ...requestData, usage: null } });
  expect(restoreFrozenState([canonical("z"), canonical("a", "tool_result"), recorded(initial), recorded(second)])).toMatchObject({ ok: false, error: { code: "invalid_commit" } });
});

test("request pairing rejects invalid appends without writing and accepts paired rewrites and stubs", async () => {
  const { appendCommit, restoreFrozenStateFromLog } = await api();
  const { log } = openLog();
  log.append(canonical("z"));
  log.append(canonical("a", "tool_result"));
  const initial = data({ summaryRequest: { ...requestData, usage: null } });
  expect(appendCommit(log, initial)).toEqual({ status: "committed" });
  const before = readFileSync(log.getLogPath(), "utf8");
  const prior = restoreFrozenStateFromLog(log);
  const stubs = [{ eventId: "a", stubText: "stub" }];
  for (const candidate of [
    data({ generation: 2, summary: markdown + "\n", summaryRequest: null }),
    data({ generation: 2, stubSet: stubs, summaryRequest: { ...requestData, usage: null } }),
  ]) {
    expect(appendCommit(log, candidate)).toMatchObject({ status: "rejected", error: { code: "invalid_commit" } });
    expect(readFileSync(log.getLogPath(), "utf8")).toBe(before);
    expect(restoreFrozenStateFromLog(log)).toEqual(prior);
  }
  expect(appendCommit(log, data({ generation: 2, stubSet: stubs, summaryRequest: null }))).toEqual({ status: "committed" });
  expect(appendCommit(log, data({ generation: 3, summary: markdown + "\n", stubSet: stubs, summaryRequest: { ...requestData, usage: null } }))).toEqual({ status: "committed" });
  expect(restoreFrozenStateFromLog(log)).toMatchObject({ ok: true, state: { generation: 3, summary: markdown + "\n", summaryRequest: { ...requestData, usage: null } } });
});

test("changing only request metadata remains an unchanged commit", async () => {
  const { restoreFrozenState, appendCommit } = await api();
  const initial = data({ summaryRequest: { ...requestData, usage: null } });
  const next = data({ generation: 2, summaryRequest: { ...requestData, capTokens: 256, usage: { input: 1 } } });
  expect(restoreFrozenState([canonical("z"), recorded(initial), recorded(next)])).toMatchObject({ ok: false, error: { code: "unchanged_commit" } });
  const { log } = openLog();
  log.append(canonical("z"));
  expect(appendCommit(log, initial)).toEqual({ status: "committed" });
  const before = readFileSync(log.getLogPath(), "utf8");
  expect(appendCommit(log, next)).toMatchObject({ status: "rejected", error: { code: "unchanged_commit" } });
  expect(readFileSync(log.getLogPath(), "utf8")).toBe(before);
});

test("stubs-only commits keep the summary and boundary, replacing the whole stub set", async () => {
  const { restoreFrozenState } = await api();
  const second = data({ generation: 2, stubSet: [{ eventId: "a", stubText: "fixed bytes" }], summaryRequest: null });
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

test("restore from log reads internal commit events", async () => {
  const { appendCommit, restoreFrozenStateFromLog } = await api();
  const { log } = openLog();
  log.append(canonical("z"));
  expect(appendCommit(log, data())).toEqual({ status: "committed" });
  expect(restoreFrozenStateFromLog(log)).toMatchObject({ ok: true, state: { generation: 1, summary: markdown } });
});

test("append rejects unreplayable commits without changing the log", async () => {
  const { appendCommit, restoreFrozenState } = await api();
  const { log } = openLog();
  log.append(canonical("z"));
  expect(appendCommit(log, data())).toEqual({ status: "committed" });
  const before = log.readAll({ includeInternal: true });
  const prior = restoreFrozenState(before);
  for (const candidate of [
    data({ generation: 3 }),
    data({ generation: 2, resetEpoch: "stale" }),
    data({ generation: 2 }),
    data({ generation: 2, summary: "new", stubSet: [{ eventId: "missing", stubText: "stub" }] }),
  ]) {
    expect(appendCommit(log, candidate)).toMatchObject({ status: "rejected" });
    expect(log.readAll({ includeInternal: true })).toEqual(before);
    expect(restoreFrozenState(log.readAll({ includeInternal: true }))).toEqual(prior);
  }
  log.append(reset("reset"));
  const afterReset = log.readAll({ includeInternal: true });
  expect(appendCommit(log, data({ resetEpoch: "reset" }))).toMatchObject({ status: "rejected", error: { code: "invalid_boundary" } });
  expect(log.readAll({ includeInternal: true })).toEqual(afterReset);
});

test("append rejects invalid input and propagates read errors without writing", async () => {
  const { appendCommit } = await api();
  const { log } = openLog();
  expect(appendCommit(log, data({ generation: 0 }))).toMatchObject({ status: "rejected" });
  const append = spyOn(log, "append");
  spyOn(log, "readAll").mockImplementation(() => { throw new Error("read failed"); });
  expect(() => appendCommit(log, data())).toThrow("read failed");
  expect(append).not.toHaveBeenCalled();
});

for (const field of ["stubSet", "summaryRequest"] as const) {
  test(`append rejects a throwing ${field} getter before reading or writing the log`, async () => {
    const { appendCommit } = await api();
    const commit = data();
    Object.defineProperty(commit, field, { get() { throw new Error(`unreadable ${field}`); } });
    const log = {
      readAll(): Event[] { throw new Error("Invalid input must not read the log"); },
      append(): Event { throw new Error("Invalid input must not write the log"); },
    };
    expect(appendCommit(log, commit)).toMatchObject({
      status: "rejected", error: { code: "invalid_commit", eventIndex: -1, message: expect.stringContaining(`unreadable ${field}`) },
    });
  });
}

test("append helper writes exactly one event, without canonical instruction or response records", async () => {
  const { appendCommit, restoreFrozenState } = await api();
  const { log } = openLog();
  log.append(canonical("z"));
  const append = spyOn(log, "append");
  try {
    expect(appendCommit(log, data())).toEqual({ status: "committed" });
    expect(append).toHaveBeenCalledTimes(1);
  } finally { append.mockRestore(); }
  const events = log.readAll({ includeInternal: true });
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
  expect(restoreFrozenState(log.readAll({ includeInternal: true }))).toMatchObject({ ok: true, state: { generation: 1 } });
  log.close();
  const reopened = new EventLog("s", root, { onCorruptLine: () => {} });
  logs.push(reopened);
  expect(reopened.corruptLineCount).toBe(1);
  expect(restoreFrozenState(reopened.readAll({ includeInternal: true }))).toMatchObject({ ok: true, state: { generation: 1 } });
  expect(appendCommit(reopened, second)).toEqual({ status: "committed" });
  reopened.close();
  const again = new EventLog("s", root, { onCorruptLine: () => {} });
  logs.push(again);
  expect(again.corruptLineCount).toBe(1);
  expect(restoreFrozenState(again.readAll({ includeInternal: true }))).toMatchObject({ ok: true, state: { generation: 2, summary: second.summary } });
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
  expect(restoreFrozenState(log.readAll({ includeInternal: true }))).toMatchObject({ ok: true, state: { generation: 1 } });
  log.close();
  const reopened = new EventLog("s", root);
  logs.push(reopened);
  expect(reopened.corruptLineCount).toBe(0);
  expect(readCommits(reopened.readAll({ includeInternal: true }))).toHaveLength(1);
  expect(restoreFrozenState(reopened.readAll({ includeInternal: true }))).toMatchObject({ ok: true, state: { generation: 1, summary: markdown } });
});

function commitNoise(log: EventLog, count: number) {
  for (let i = 0; i < count; i++) log.append(recorded(data({ summary: "needle" }), `commit-${i}`));
}
function visible(log: EventLog, id: string, kind: "user_message" | "agent_message" | "system_note" = "user_message", payload: Record<string, unknown> = { text: "needle" }) {
  log.append({ event_id: id, kind, actor: "kernel", timestamp: 123, payload });
}

test("commit isolation filters search before its limit, even explicit kinds and raw tool fallback", async () => {
  const { log } = openLog();
  commitNoise(log, 3);
  visible(log, "legitimate");
  expect(log.search("needle", { limit: 1 }).map(m => m.event.event_id)).toEqual(["legitimate"]);
  expect(log.search("needle", { kinds: [commitKind] })).toEqual([]);
  expect(log.search("needle", { afterResetBoundary: true, limit: 1 }).map(m => m.event.event_id)).toEqual(["legitimate"]);
  const tools = createMemoryTools({ eventLog: log, stateGraph: new StateGraph(), includeWorkingMemoryTools: false });
  const result = await tools.search_session_log.execute({ query: "needle", limit: 1 });
  expect(result).toMatchObject({ matchCount: 1, matches: [{ kind: "user_message" }] });
  expect(JSON.stringify(result)).not.toContain("compaction_commit");
});

test("all generic bounded reads and getLastEvent exclude both internal kinds; raw access preserves both", () => {
  const { log } = openLog();
  visible(log, "legitimate");
  log.append(canonical("canonical"));
  commitNoise(log, 10);
  for (const events of [log.readLast(1), log.readLastUncompressed(1), log.readLastUncompressedAfterResetBoundary(1), log.readAll(), log.readAllUncompressed(), log.readAllAfterResetBoundary(), log.readAllUncompressedAfterResetBoundary()]) {
    expect(events.map(e => e.event_id)).toEqual(["legitimate"]);
  }
  expect(log.getLastEvent()?.event_id).toBe("legitimate");
  expect(log.replayContextActions()).toEqual([]);
  const raw = log.readAll({ includeInternal: true });
  expect(raw).toHaveLength(12);
  expect(readFullSessionCanonicalRecords(raw)).toHaveLength(1);
  expect(log.getLastEvent({ includeInternal: true })?.event_id).toBe("commit-9");
  raw.length = 0;
  expect(log.readAll({ includeInternal: true })).toHaveLength(12);
});

test("getLastEvent returns null for an internal-only log but raw anchors remain available", () => {
  const { log } = openLog();
  log.append(canonical("canonical"));
  commitNoise(log, 2);
  expect(log.getLastEvent()).toBeNull();
  expect(log.readAll()).toEqual([]);
  expect(log.getLastEvent({ includeInternal: true })?.event_id).toBe("commit-1");
});

test("auto-compact selection keeps identical ids, counts and content in a commit-filled log", async () => {
  const { log } = openLog();
  const config = loadConfig();
  config.compiler = { ...config.compiler, auto_compact_at: 0.75, auto_compact_clear_at: 0.55, compact_chunk_fraction: 0.5, reserved_output_tokens: 0 };
  const compressed = spyOn(log, "markEventsAsCompressed");
  const compressTurns = mock(async () => 2);
  const session = { config, eventLog: log, memoryEnabled: true, memoryStore: { compressTurns }, isCompactionArmed: () => false, setCompactionArmed() {}, getContextWindowTokens: () => 10000, debug: false } as unknown as Session;
  commitNoise(log, 20);
  for (let i = 0; i < 6; i++) visible(log, `legacy-${i}`, i % 2 ? "agent_message" : "user_message", { text: `message ${i}` });
  const result = await maybeAutoCompactClassic(session, 8000, "test/model");
  expect(result).toMatchObject({ compacted: true, eventsCompacted: 3, factsStored: 2 });
  expect(compressed).toHaveBeenCalledWith(["legacy-0", "legacy-1", "legacy-2"]);
  expect(compressTurns.mock.calls[0][0]).toEqual([
    { type: "user_message", timestamp: 123, content: "message 0" },
    { type: "agent_message", timestamp: 123, content: "message 1" },
    { type: "user_message", timestamp: 123, content: "message 2" },
  ]);
});

test("events command retains its twenty visible entries despite trailing commits", async () => {
  const { log } = openLog();
  for (let i = 0; i < 20; i++) visible(log, `legacy-${i}`, "user_message", { text: `message ${i}` });
  const handlers = { setModel() {}, setThinking() {}, getThinking: () => false };
  const baseline = await executeSlashCommand("/events", { eventLog: log } as Session, handlers);
  commitNoise(log, 20);
  expect(await executeSlashCommand("/events", { eventLog: log } as Session, handlers)).toEqual(baseline);
  expect(JSON.stringify(baseline)).toContain("message 0");
});

test("recent banner is not starved by trailing internal commits", () => {
  const { log } = openLog();
  visible(log, "legitimate", "user_message", { text: "visible conversation" });
  const session = { eventLog: log } as Session;
  const baseline = formatRecentConversationLines(session, 1);
  commitNoise(log, 30);
  expect(formatRecentConversationLines(session, 1)).toEqual(baseline);
  expect(baseline.join("\n")).toContain("visible conversation");
});

test("memory statistics retain legitimate recalls outside a commit-filled fifty-event window", () => {
  const { log } = openLog();
  visible(log, "recall", "system_note", { type: "memory_recall", hits: 7 });
  const session = { eventLog: log, getMemoryStats: () => ({ active: 0, total: 0 }), digest: null } as unknown as Session;
  const baseline = computeMemoryStats(session, 0);
  commitNoise(log, 50);
  expect(computeMemoryStats(session, 0)).toEqual(baseline);
  expect(baseline).toMatchObject({ recallCalls: 1, recallHits: 7 });
});

test("checkpoint anchors resolve a hidden commit id and resume replays the following action", async () => {
  const { appendCommit } = await api();
  const { log, root } = openLog();
  log.close();
  const config = loadConfig();
  config.session.log_dir = root;
  config.memory.enabled = false;
  config.memory.summarizer = "disabled";
  config.context_engine!.enabled = false;
  config.native = { ...config.native!, enabled: false };
  config.skills.enabled = false;
  config.project_detection!.enabled = false;
  const session = Session.createNew("s", root, config);
  logs.push(session.eventLog);
  const task = session.stateGraph.create("task", { title: "checkpoint task" });
  await new CanonicalWriter(session.eventLog, error => { throw error; }).startTurn("input");
  const boundary = session.eventLog.getLastEvent({ includeInternal: true })!.event_id;
  expect(appendCommit(session.eventLog, data({ boundaryEventId: boundary }))).toEqual({ status: "committed" });
  expect(session.eventLog.readAll()).toHaveLength(0);
  session.incrementTurn();
  session.persistStateGraphCheckpoint();
  const checkpoint = loadStateGraphCheckpoint(join(root, "s"))!;
  const raw = session.eventLog.readAll({ includeInternal: true });
  expect(checkpoint.last_event_id).toBe(raw[1].event_id);
  expect(raw[1].kind).toBe("compaction_commit");
  expect(findReplayStartIndex(raw, checkpoint.last_event_id)).toBe(2);
  session.eventLog.append({ kind: "context_action", actor: "kernel", payload: { action: "update", id: task.id, statePayload: { title: "after anchor" }, updated: Date.now() } });
  session.eventLog.close();
  const resumed = await Session.resume(session.id, root, config, { suppressLoggerStderr: true });
  logs.push(resumed.eventLog);
  expect(resumed.stateGraph.get(task.id)?.payload.title).toBe("after anchor");
  expect(resumed.getTurnCount()).toBe(1);
});

test("reset boundary indices and turn counts stay correct in raw and generic views with commits", () => {
  const { log } = openLog();
  visible(log, "old");
  commitNoise(log, 3);
  log.logResetBoundary("/clear");
  visible(log, "new");
  const generic = log.readAll();
  expect(generic.map(e => e.kind)).toEqual(["user_message", "system_note", "user_message"]);
  for (const events of [generic, log.readAll({ includeInternal: true })]) {
    expect(findLastResetBoundaryTurn(events)).toBe(0);
    expect(events[findLastResetBoundaryIndex(events)].payload.type).toBe("reset_boundary");
    expect(eventsAfterResetBoundary(events).map(e => e.event_id)).toEqual(["new"]);
  }
});
