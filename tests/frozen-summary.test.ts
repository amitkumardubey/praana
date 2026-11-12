import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
