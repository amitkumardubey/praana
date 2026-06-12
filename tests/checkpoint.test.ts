import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateGraph } from "../src/state-graph.js";
import {
  reconcileCheckpoint,
  renderCheckpoint,
  replayCheckpointFromDigests,
  createEmptyCheckpointState,
} from "../src/context-engine/checkpoint.js";
import { ContextEngine } from "../src/context-engine/index.js";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import { TurnRecorder } from "../src/context-engine/turn-recorder.js";
import type { CheckpointDraft, TurnDigest } from "../src/context-engine/types.js";
import type { ContextEngineConfig } from "../src/types.js";

const TEST_CONFIG: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 50,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
  pressure: { compact_at: 0.7, emergency_at: 0.85 },
};

function makeDraft(overrides: Partial<CheckpointDraft> = {}): CheckpointDraft {
  return {
    lastUserIntent: "",
    openErrors: [],
    recentDecisions: [],
    recentConstraints: [],
    recentActivity: [],
    ...overrides,
  };
}

function makeDigest(overrides: Partial<TurnDigest> = {}): TurnDigest {
  return {
    turnId: 0,
    userIntent: "implement auth",
    filesChanged: [],
    filesWritten: [],
    artifactRefs: [],
    decisions: [],
    constraints: [],
    errorsNew: [],
    errorsFixed: [],
    toolSummary: "no tools",
    ...overrides,
  };
}

describe("session checkpoint", () => {
  it("reconciles active request, constraints, and decisions", () => {
    let state = createEmptyCheckpointState();
    const digest = makeDigest({
      turnId: 2,
      userIntent: "add JWT auth",
      constraints: ["never store plaintext passwords"],
      decisions: [{ summary: "use sqlite for sessions", rationale: "simple, local" }],
    });

    state = reconcileCheckpoint(state, digest, makeDraft(), 2);

    expect(state.activeRequest).toBe("add JWT auth");
    expect(state.constraints).toContain("never store plaintext passwords");
    expect(state.decisions).toEqual([
      expect.objectContaining({
        summary: "use sqlite for sessions",
        rationale: "simple, local",
        turn: 2,
      }),
    ]);
  });

  it("retains decision rationale after compaction", () => {
    let state = createEmptyCheckpointState();
    state = reconcileCheckpoint(
      state,
      makeDigest({
        turnId: 2,
        decisions: [{ summary: "use SQLite", rationale: "simple, local, no infra" }],
      }),
      makeDraft(),
      2,
    );

    state = reconcileCheckpoint(
      state,
      makeDigest({ turnId: 15, userIntent: "add rate limiting" }),
      makeDraft(),
      15,
    );

    const rendered = renderCheckpoint({ version: 1, state });
    expect(state.decisions[0]?.compact).toBe(true);
    expect(rendered).toContain("use SQLite");
    expect(rendered).toContain("simple, local, no infra");
    expect(rendered).toContain("— simple, local, no infra");
  });

  it("reconciles narrative entries from meaningful turns", () => {
    let state = createEmptyCheckpointState();
    state = reconcileCheckpoint(
      state,
      makeDigest({
        turnId: 1,
        userIntent: "set up TypeScript project",
        filesWritten: ["package.json"],
      }),
      makeDraft(),
      1,
    );

    state = reconcileCheckpoint(
      state,
      makeDigest({
        turnId: 5,
        userIntent: "add auth",
        decisions: [{ summary: "use SQLite" }],
      }),
      makeDraft(),
      5,
    );

    expect(state.narrative.length).toBeGreaterThanOrEqual(2);
    const rendered = renderCheckpoint({ version: 1, state });
    expect(rendered).toContain("### Session narrative");
    expect(rendered).toContain("use SQLite");
  });

  it("trims oldest narrative entries when rendered prose exceeds token budget", () => {
    let state = createEmptyCheckpointState();
    // Add many narrative entries to exceed the 400-token render budget
    for (let i = 0; i < 25; i++) {
      state = reconcileCheckpoint(
        state,
        makeDigest({
          turnId: i,
          userIntent: `implement feature ${i} with a long description that adds tokens`,
          filesWritten: [`src/feature${i}.ts`],
        }),
        makeDraft(),
        i,
      );
    }

    const rendered = renderCheckpoint({ version: 1, state });
    expect(rendered).toContain("### Session narrative");
    // Oldest entries should be trimmed; newest should survive
    expect(rendered).toContain("feature 24");
    expect(rendered).not.toContain("feature 0");
  });

  it("tracks plan history and supersession", () => {
    let state = createEmptyCheckpointState();
    const planA = "1. Set up project\n2. Add auth\n3. Add tests";
    const planB = "1. Add auth\n2. Add tests\n3. Deploy";

    state = reconcileCheckpoint(
      state,
      makeDigest({
        turnId: 3,
        extractedPlan: planA,
        filesWritten: ["package.json"],
      }),
      makeDraft(),
      3,
    );

    state = reconcileCheckpoint(
      state,
      makeDigest({
        turnId: 10,
        extractedPlan: planB,
        filesWritten: ["src/auth.ts"],
      }),
      makeDraft(),
      10,
    );

    expect(state.plans).toHaveLength(2);
    expect(state.plans[0]?.superseded).toBe(true);
    expect(state.plans[1]?.superseded).toBe(false);

    const rendered = renderCheckpoint({ version: 1, state });
    expect(rendered).toContain("### Plan");
    expect(rendered).toContain("Current (turn 10)");
    expect(rendered).toContain("Superseded plans");
    expect(rendered).toContain("[turn 3]");
  });

  it("never drops constraints once added", () => {
    let state = createEmptyCheckpointState();
    state = reconcileCheckpoint(
      state,
      makeDigest({ turnId: 0, constraints: ["C1"] }),
      makeDraft(),
      0,
    );
    state = reconcileCheckpoint(
      state,
      makeDigest({ turnId: 1, constraints: ["C2"] }),
      makeDraft({ recentConstraints: ["C1", "C2"] }),
      1,
    );

    expect(state.constraints).toEqual(["C1", "C2"]);
  });

  it("renders open errors with full detail and fixed errors as one-liners", () => {
    let state = createEmptyCheckpointState();
    const digest = makeDigest({
      turnId: 3,
      errorsNew: ["TypeError in auth.ts"],
      errorsFixed: ["npm test"],
    });
    const draft = makeDraft({
      openErrors: [
        {
          key: "shell:npm test",
          message: "TypeError in auth.ts",
          turn: 2,
          tool: "shell",
          command: "npm test",
        },
      ],
    });

    state = reconcileCheckpoint(state, digest, draft, 3);
    const rendered = renderCheckpoint({ version: 1, state });

    expect(rendered).toContain("### Open errors");
    expect(rendered).toContain("TypeError in auth.ts");
    expect(rendered).toContain("Fixed: npm test");
  });

  it("replays checkpoint from stored digests", () => {
    const digests: TurnDigest[] = [
      makeDigest({
        turnId: 0,
        userIntent: "start auth",
        constraints: ["use JWT"],
        decisions: [{ summary: "sqlite sessions" }],
      }),
      makeDigest({
        turnId: 1,
        userIntent: "fix tests",
        filesChanged: ["src/auth.ts"],
        errorsNew: ["2 failing"],
      }),
    ];

    const state = replayCheckpointFromDigests(digests, [
      { turn: 1, type: "file_written", summary: "Wrote: src/auth.ts" },
    ]);

    expect(state.activeRequest).toBe("fix tests");
    expect(state.constraints).toContain("use JWT");
    expect(state.decisions[0]?.summary).toBe("sqlite sessions");
    expect(state.files.some((f) => f.path === "src/auth.ts")).toBe(true);
  });
});

describe("checkpoint store integration", () => {
  let store: ArtifactStore;
  let engine: ContextEngine;

  afterEach(() => {
    engine.close();
  });

  beforeEach(() => {
    store = ArtifactStore.open(":memory:", "sess-checkpoint", TEST_CONFIG);
    engine = ContextEngine.open(":memory:", "sess-checkpoint", TEST_CONFIG);
  });

  it("persists and restores checkpoint across engine instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "aria-checkpoint-"));
    const dbPath = join(dir, "memory.db");
    engine.close();
    engine = ContextEngine.open(dbPath, "sess-checkpoint", TEST_CONFIG);

    const sg = new StateGraph();
    const before = engine.captureStateSnapshot(sg);
    sg.create("decision", {
      summary: "JWT with 1h expiry",
      rationale: "security",
    });
    sg.create("constraint", { text: "rate-limit auth endpoints" });

    const record = {
      turn: 0,
      userMessage: "implement auth",
      assistantMessage: "done",
      toolCalls: [
        {
          tool: "write_file",
          args: { path: "src/auth.ts", content: "..." },
          isError: false,
        },
      ],
      artifactIds: [],
      filesRead: [],
      filesWritten: ["src/auth.ts"],
      errors: [],
      tokenCount: 50,
      timestamp: Date.now(),
    };

    engine.processTurnExtraction({
      userMessage: "implement auth",
      record,
      stateBefore: before,
      stateGraph: sg,
    });

    const rendered = engine.renderCheckpointSection();
    expect(rendered).toContain("Session Checkpoint");
    expect(rendered).toContain("JWT with 1h expiry");
    expect(rendered).toContain("rate-limit auth endpoints");

    engine.close();

    const resumed = ContextEngine.open(dbPath, "sess-checkpoint", TEST_CONFIG);
    const restored = resumed.renderCheckpointSection();
    resumed.close();
    rmSync(dir, { recursive: true, force: true });

    expect(restored).toContain("JWT with 1h expiry");
  });

  it("includes checkpoint section content via renderContextSummary", () => {
    const sg = new StateGraph();
    const before = engine.captureStateSnapshot(sg);
    sg.create("decision", { summary: "ship phase 5", rationale: "milestone" });

    const recorder = new TurnRecorder("finish checkpoint");
    recorder.recordToolCall({
      tool: "write_file",
      args: { path: "src/checkpoint.ts", content: "x" },
      result: { ok: true },
      isError: false,
    });

    const record = recorder.toRecord("done", 0, 100);
    engine.processTurnExtraction({
      userMessage: "finish checkpoint",
      record,
      stateBefore: before,
      stateGraph: sg,
    });

    const summary = engine.renderContextSummary();
    expect(summary).toContain("finish checkpoint");
    expect(summary).toContain("ship phase 5");
  });
});
