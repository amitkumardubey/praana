import { describe, it, expect } from "vitest";
import { compileEngineWithMetrics } from "../src/context-engine/engine-compiler.js";
import { createEmptyCheckpointState } from "../src/context-engine/checkpoint.js";
import { scoreContextUnit } from "../src/context-engine/scoring.js";
import type { ContextEngineConfig } from "../src/types.js";
import type { ContextUnit, SessionCheckpoint } from "../src/context-engine/types.js";

const ENGINE_CONFIG: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 400,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3, w_hydrate_boost: 0.2 },
  pressure: { compact_at: 0.7, emergency_at: 0.85 },
};

function emptyStateGraph() {
  return {
    list: () => [],
    getActive: () => [],
    getPeripheral: () => [],
    snapshot: () => [],
  } as any;
}

describe("engine compiler", () => {
  it("is deterministic for the same input", () => {
    const input = {
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "fix failing tests",
      toolSchemas: ["shell(command)"],
      cwd: "/proj",
      sessionId: "sess-1",
      tokenBudget: 100_000,
      checkpointSection: "## Session Checkpoint\n\n### Active Request\nfix tests",
      currentTurn: 5,
      turnRecords: [
        {
          turn: 3,
          userMessage: "run tests",
          assistantMessage: "running npm test",
          toolCalls: [
            {
              tool: "shell",
              args: { command: "npm test" },
              isError: true,
              resultText: "2 failing",
            },
          ],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: ["2 failing"],
          tokenCount: 100,
          timestamp: 1,
        },
        {
          turn: 4,
          userMessage: "fix auth",
          assistantMessage: "patched auth.ts",
          toolCalls: [],
          artifactIds: [],
          filesRead: ["src/auth.ts"],
          filesWritten: ["src/auth.ts"],
          errors: [],
          tokenCount: 80,
          timestamp: 2,
        },
      ],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
    };

    const a = compileEngineWithMetrics(input);
    const b = compileEngineWithMetrics(input);
    expect(a.prompt).toBe(b.prompt);
    expect(a.scoreRecords).toEqual(b.scoreRecords);
  });

  it("includes checkpoint and verbatim recent turns in the prompt", () => {
    const result = compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "continue",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-2",
      tokenBudget: 100_000,
      checkpointSection: "## Session Checkpoint\n\n### Decisions\n- use sqlite",
      currentTurn: 8,
      turnRecords: [
        {
          turn: 5,
          userMessage: "older digest turn",
          assistantMessage: "done",
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 1,
        },
        {
          turn: 7,
          userMessage: "latest",
          assistantMessage: "ok",
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 2,
        },
        {
          turn: 8,
          userMessage: "current",
          assistantMessage: "working",
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 3,
        },
      ],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
    });

    expect(result.prompt).toContain("Session Checkpoint");
    expect(result.prompt).toContain("use sqlite");
    expect(result.prompt).toContain("Recent Turns (verbatim)");
    expect(result.prompt).toContain("latest");
    expect(result.scoreRecords.some((r) => r.type === "turn_digest")).toBe(true);
  });

  it("scores pinned units higher than stale low-relevance units", () => {
    const unit: ContextUnit = {
      id: "turn_3",
      type: "turn_digest",
      content: "fix failing auth tests in src/auth.ts",
      tokens: 50,
      sourceTurn: 3,
      score: 0,
      pinned: false,
      artifactRefs: [],
    };
    const pinned: ContextUnit = { ...unit, id: "pinned", pinned: true };
    const recent = scoreContextUnit(unit, 5, "fix failing tests", ENGINE_CONFIG.scoring);
    const pinnedScore = scoreContextUnit(pinned, 5, "fix failing tests", ENGINE_CONFIG.scoring);
    expect(pinnedScore.score).toBeGreaterThan(recent.score);
  });

  it("hydrate_boost increases score when unit content overlaps hydrated object text", () => {
    const unit: ContextUnit = {
      id: "turn_5",
      type: "turn_digest",
      content: "Updated the login authentication handler to fix the 401 error",
      tokens: 50,
      sourceTurn: 5,
      score: 0,
      pinned: false,
      artifactRefs: [],
    };
    const weights = ENGINE_CONFIG.scoring; // w_hydrate_boost: 0.2
    const baseResult = scoreContextUnit(unit, 10, "auth bug", weights);
    const boostedResult = scoreContextUnit(unit, 10, "auth bug", weights, [
      "Fix authentication bug — Login endpoint returns 401",
    ]);
    expect(boostedResult.score).toBeGreaterThan(baseResult.score);
    expect(boostedResult.breakdown.hydrate_boost).toBeGreaterThan(0);
  });

  it("hydrate_boost is zero when hydratedTexts is empty or w_hydrate_boost is 0", () => {
    const unit: ContextUnit = {
      id: "turn_6",
      type: "turn_digest",
      content: "login auth handler",
      tokens: 30,
      sourceTurn: 6,
      score: 0,
      pinned: false,
      artifactRefs: [],
    };
    const weightsNoBoost = { ...ENGINE_CONFIG.scoring, w_hydrate_boost: 0 };
    const r1 = scoreContextUnit(unit, 10, "auth", weightsNoBoost, ["login auth handler"]);
    expect(r1.breakdown.hydrate_boost).toBe(0);

    const r2 = scoreContextUnit(unit, 10, "auth", ENGINE_CONFIG.scoring, []);
    expect(r2.breakdown.hydrate_boost).toBe(0);
  });

  it("hydratedTexts flow through compileEngineWithMetrics to scoring", () => {
    // Turn age must be in [3, 6] to be emitted as a scored digest unit.
    // With currentTurn=10, turn=5 gives age=5 — within the scored window.
    const baseResult = compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "auth issue",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-3",
      tokenBudget: 100_000,
      checkpointSection: "",
      currentTurn: 10,
      turnRecords: [{ turn: 5, userMessage: "fix auth", assistantMessage: "fixed authentication login endpoint returning 401 error", toolCalls: [], artifactIds: [], filesRead: [], filesWritten: [], errors: [], tokenCount: 50, timestamp: 1 }],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
    });
    const boostedResult = compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "auth issue",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-4",
      tokenBudget: 100_000,
      checkpointSection: "",
      currentTurn: 10,
      turnRecords: [{ turn: 5, userMessage: "fix auth", assistantMessage: "fixed authentication login endpoint returning 401 error", toolCalls: [], artifactIds: [], filesRead: [], filesWritten: [], errors: [], tokenCount: 50, timestamp: 1 }],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
      hydratedTexts: ["Fix authentication login bug — endpoint returning 401"],
    });
    const basePick = baseResult.scoreRecords.find((r) => r.unitId.includes("turn"));
    const boostedPick = boostedResult.scoreRecords.find((r) => r.unitId.includes("turn"));
    expect(basePick).toBeDefined();
    expect(boostedPick).toBeDefined();
    expect(boostedPick!.breakdown.hydrate_boost).toBeGreaterThan(0);
    expect(boostedPick!.score).toBeGreaterThan(basePick!.score);
  });

  it("uses weighted pressure lower than raw token ratio for finding-heavy checkpoint", () => {
    const state = createEmptyCheckpointState();
    state.decisions = [
      { summary: "use sqlite", rationale: "local", turn: 2, compact: false },
    ];
    state.findings = Array.from({ length: 30 }, (_, i) => ({
      summary: `Verbose error trace and artifact dump ${i} `.repeat(30),
      artifactRef: `art-${i}`,
      turn: i,
    }));
    state.activity = Array.from({ length: 15 }, (_, i) => ({
      turn: i,
      type: "tool_call" as const,
      summary: `shell npm test iteration ${i}`,
    }));

    const checkpoint: SessionCheckpoint = { version: 1, state };
    const smallWindow = 8_000;

    const result = compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "continue",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-density",
      tokenBudget: smallWindow,
      contextWindowTokens: smallWindow,
      checkpoint,
      currentTurn: 10,
      turnRecords: [],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
    });

    const rawRatio = result.metrics.totalTokens / smallWindow;
    expect(result.weightedTokens).toBeLessThan(result.metrics.totalTokens);
    expect(result.pressureRatio).toBeLessThan(rawRatio);
  });

  it("emergency checkpoint in prompt omits findings when pressure is high", () => {
    const state = createEmptyCheckpointState();
    state.decisions = [
      { summary: "keep this decision", rationale: "important", turn: 1, compact: false },
    ];
    state.findings = Array.from({ length: 30 }, (_, i) => ({
      summary: `Low value finding ${i} `.repeat(40),
      turn: i,
    }));

    const checkpoint: SessionCheckpoint = { version: 1, state };
    const tinyWindow = 2_000;

    const result = compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "x".repeat(3000),
      toolSchemas: ["shell(command)"],
      cwd: "/proj",
      sessionId: "sess-emergency",
      tokenBudget: tinyWindow,
      contextWindowTokens: tinyWindow,
      checkpoint,
      currentTurn: 5,
      turnRecords: [
        {
          turn: 4,
          userMessage: "run",
          assistantMessage: "ok",
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 1,
        },
        {
          turn: 5,
          userMessage: "again",
          assistantMessage: "done",
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 2,
        },
      ],
      activityEntries: [],
      engineConfig: {
        ...ENGINE_CONFIG,
        pressure: { compact_at: 0.5, emergency_at: 0.7 },
      },
    });

    expect(result.pressureMode).toBe("emergency");
    expect(result.prompt).toContain("keep this decision");
    expect(result.prompt).not.toContain("### Findings");
  });

  it("does not double-count agentsContext in weighted pressure", () => {
    const largeAgents = "AGENTS ".repeat(4000);
    const base = {
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "continue",
      toolSchemas: ["shell(command)"],
      cwd: "/proj",
      sessionId: "sess-agents-dc",
      tokenBudget: 100_000,
      contextWindowTokens: 100_000,
      checkpointSection: "",
      currentTurn: 2,
      turnRecords: [],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
    };

    const withoutAgents = compileEngineWithMetrics({ ...base, agentsContext: "" });
    const withAgents = compileEngineWithMetrics({ ...base, agentsContext: largeAgents });
    const agentsTokens = withAgents.metrics.agentsContextTokens;
    expect(agentsTokens).toBeGreaterThan(1000);

    const delta = withAgents.weightedTokens - withoutAgents.weightedTokens;
    expect(delta).toBeGreaterThan(agentsTokens * 0.7);
    expect(delta).toBeLessThan(agentsTokens * 1.3);
  });

  it("reports compact pressure mode when checkpoint renders in compact mode", () => {
    const state = createEmptyCheckpointState();
    state.decisions = [
      { summary: "keep compact decision", rationale: "important", turn: 1, compact: false },
    ];
    state.findings = Array.from({ length: 30 }, (_, i) => ({
      summary: `Finding ${i} `.repeat(30),
      turn: i,
    }));
    state.activity = Array.from({ length: 12 }, (_, i) => ({
      turn: i,
      type: "tool_call" as const,
      summary: `activity-${i}`,
    }));

    const checkpoint: SessionCheckpoint = { version: 1, state };
    const window = 2_500;

    const result = compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "x".repeat(1000),
      toolSchemas: ["shell(command)"],
      cwd: "/proj",
      sessionId: "sess-pressure-mode",
      tokenBudget: window,
      contextWindowTokens: window,
      checkpoint,
      currentTurn: 5,
      turnRecords: [],
      activityEntries: [],
      engineConfig: {
        ...ENGINE_CONFIG,
        pressure: { compact_at: 0.3, emergency_at: 0.85 },
      },
    });

    expect(result.pressureMode).toBe("compact");
    expect(result.prompt).toContain("keep compact decision");
    expect(result.prompt).toContain("activity-11");
    expect(result.prompt).not.toContain("activity-0");
  });
});
