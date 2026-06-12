import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateGraph } from "../src/state-graph.js";
import { deriveActivityEntries } from "../src/context-engine/activity-log.js";
import { TurnExtraction } from "../src/context-engine/extraction.js";
import { ErrorTracker } from "../src/context-engine/error-tracker.js";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import {
  buildToolSummary,
  extractImplicitConstraints,
  extractPlan,
  extractTurnDigest,
  extractUserIntent,
} from "../src/context-engine/turn-digest.js";
import { snapshotStateGraph } from "../src/context-engine/state-snapshot.js";
import type { ContextEngineConfig } from "../src/types.js";
import type { TurnRecord as EngineTurnRecord } from "../src/context-engine/types.js";

const TEST_CONFIG: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 50,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 5,
  checkpoint_enabled: true,
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
  pressure: { compact_at: 0.7, emergency_at: 0.85 },
};

function makeRecord(overrides: Partial<EngineTurnRecord> = {}): EngineTurnRecord {
  return {
    turn: 0,
    userMessage: "fix tests",
    assistantMessage: "done",
    toolCalls: [],
    artifactIds: [],
    filesRead: [],
    filesWritten: [],
    errors: [],
    tokenCount: 100,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("turn digest", () => {
  it("truncates long user intent", () => {
    const long = "a".repeat(200);
    expect(extractUserIntent(long)).toHaveLength(120);
    expect(extractUserIntent(long).endsWith("...")).toBe(true);
  });

  it("summarizes tool calls by name and count", () => {
    const record = makeRecord({
      toolCalls: [
        { tool: "read_file", args: { path: "a.ts" }, isError: false },
        { tool: "read_file", args: { path: "b.ts" }, isError: false },
        { tool: "shell", args: { command: "npm test" }, isError: false },
      ],
    });
    expect(buildToolSummary(record)).toBe("read_file×2, shell");
  });

  it("detects new decisions and constraints from state graph diff", () => {
    const sg = new StateGraph();
    const before = snapshotStateGraph(sg);

    sg.create("decision", { summary: "use sqlite", rationale: "storage" });
    sg.create("constraint", { text: "no raw SQL in handlers" });

    const digest = extractTurnDigest({
      turn: 1,
      userMessage: "pick storage",
      record: makeRecord({ turn: 1 }),
      stateBefore: before,
      stateGraph: sg,
      errorsNew: [],
      errorsFixed: [],
    });

    expect(digest.decisions.map((d) => d.summary)).toContain("use sqlite");
    expect(digest.decisions[0]?.rationale).toBe("storage");
    expect(digest.constraints).toContain("no raw SQL in handlers");
  });

  it("extracts implicit constraints from 'not X, Y' correction patterns only", () => {
    // The 'not X, Y' pattern is the only regex capture — it's syntactically
    // unambiguous (user directly reversing a wrong choice).
    // All other patterns ("let's use", "we use", "I prefer", "make sure")
    // are the LLM's responsibility via the system prompt nudge.
    expect(extractImplicitConstraints("not npm, pnpm")).toEqual([
      "Use pnpm, not npm",
    ]);
    expect(extractImplicitConstraints("not npm, but actually pnpm")).toEqual([
      "Use pnpm, not npm",
    ]);
    // These are NOT captured by regex — the LLM handles them via prompt nudge
    expect(extractImplicitConstraints("let's use pnpm")).toEqual([]);
    expect(extractImplicitConstraints("we use pnpm here")).toEqual([]);
    expect(extractImplicitConstraints("I prefer tabs over spaces")).toEqual([]);
    expect(extractImplicitConstraints("make sure to run tests first")).toEqual([]);
    expect(extractImplicitConstraints("")).toEqual([]);
    expect(extractImplicitConstraints("can you add a test?")).toEqual([]);
  });

  it("extracts plan text from assistant messages", () => {
    const message = [
      "The plan is:",
      "1. Set up project",
      "2. Add auth",
      "3. Add tests",
    ].join("\n");
    expect(extractPlan(message)).toContain("1. Set up project");
    expect(extractPlan(message)).toContain("2. Add auth");
  });

  it("extracts plan from prose with 'the plan is'", () => {
    expect(extractPlan("The plan is to set up auth, then deploy")).toBe(
      "set up auth, then deploy",
    );
  });

  it("extracts plan from markdown task lists", () => {
    const message = [
      "Here's what I'll do:",
      "- [ ] Set up project",
      "- [ ] Add auth",
      "- [x] Write tests",
    ].join("\n");
    const plan = extractPlan(message);
    expect(plan).toContain("[ ] Set up project");
    expect(plan).toContain("[x] Write tests");
  });

  it("returns null for single-item plans", () => {
    expect(extractPlan("1. Do the thing")).toBeNull();
  });

  it("returns null for no-plan messages", () => {
    expect(extractPlan("I wrote the file successfully")).toBeNull();
  });

  it("ignores plans inside code blocks", () => {
    const message = [
      "Here's the config:",
      "```json",
      "1. Set up",
      "2. Deploy",
      "```",
      "The plan is:",
      "1. Actually step one",
      "2. Actually step two",
    ].join("\n");
    const plan = extractPlan(message);
    expect(plan).toContain("Actually step one");
    expect(plan).not.toContain("Deploy");
  });

  it("adds 'not X, Y' corrections to turn digest", () => {
    const digest = extractTurnDigest({
      turn: 1,
      userMessage: "not npm, pnpm",
      record: makeRecord({ turn: 1 }),
      stateBefore: snapshotStateGraph(new StateGraph()),
      stateGraph: new StateGraph(),
      errorsNew: [],
      errorsFixed: [],
    });

    expect(digest.constraints).toContain("Use pnpm, not npm");
  });

  it("derives activity entries for commits, tests, and file writes", () => {
    const record = makeRecord({
      toolCalls: [
        {
          tool: "shell",
          args: { command: "git commit -m fix auth" },
          isError: false,
          resultText: JSON.stringify({ stdout: "fix auth\n1 file changed" }),
        },
        {
          tool: "shell",
          args: { command: "npm test" },
          isError: true,
          resultText: "3 failing tests",
        },
        {
          tool: "write_file",
          args: { path: "src/auth.ts", content: "..." },
          isError: false,
        },
      ],
    });

    const digest = extractTurnDigest({
      turn: 2,
      userMessage: "commit and test",
      record,
      stateBefore: snapshotStateGraph(new StateGraph()),
      stateGraph: new StateGraph(),
      errorsNew: ["3 failing tests"],
      errorsFixed: [],
    });

    const entries = deriveActivityEntries(2, digest, record, false);
    const types = entries.map((e) => e.type);
    expect(types).toContain("commit");
    expect(types).toContain("test_fail");
    expect(types).toContain("file_written");
  });

  it("tracks open errors and marks fixes on successful retry", () => {
    const tracker = new ErrorTracker();
    const fail = makeRecord({
      toolCalls: [
        {
          tool: "shell",
          args: { command: "npm test" },
          isError: true,
          resultText: "2 failing",
        },
      ],
      errors: ["2 failing"],
    });
    const failResult = tracker.processTurn(0, fail);
    expect(failResult.errorsNew.length).toBeGreaterThan(0);
    expect(tracker.isTestFailed()).toBe(true);

    const pass = makeRecord({
      turn: 1,
      toolCalls: [
        {
          tool: "shell",
          args: { command: "npm test" },
          isError: false,
          resultText: "all passed",
        },
      ],
    });
    const passResult = tracker.processTurn(1, pass);
    expect(passResult.errorsFixed.length).toBeGreaterThan(0);
    expect(tracker.isTestFailed()).toBe(false);
  });
});

describe("turn extraction", () => {
  let store: ArtifactStore;

  afterEach(() => {
    store.close();
  });

  beforeEach(() => {
    store = ArtifactStore.open(":memory:", "sess-digest", TEST_CONFIG);
  });

  it("persists digest and activity through TurnExtraction", () => {
    const extraction = new TurnExtraction(
      store.getDb(),
      "sess-digest",
      TEST_CONFIG,
    );
    const sg = new StateGraph();
    const before = extraction.captureStateSnapshot(sg);
    sg.create("decision", { summary: "ship phase 4", rationale: "milestone" });

    const record = makeRecord({
      turn: 0,
      toolCalls: [
        {
          tool: "write_file",
          args: { path: "src/foo.ts", content: "x" },
          isError: false,
        },
      ],
      filesWritten: ["src/foo.ts"],
    });

    const digest = extraction.processTurn({
      userMessage: "finish phase 4",
      record,
      stateBefore: before,
      stateGraph: sg,
    });

    expect(digest.userIntent).toBe("finish phase 4");
    expect(digest.decisions.map((d) => d.summary)).toContain("ship phase 4");

    const draft = extraction.getCheckpointDraft();
    expect(draft.lastUserIntent).toBe("finish phase 4");
    expect(draft.recentActivity.some((e) => e.type === "file_written")).toBe(
      true,
    );
  });
});
