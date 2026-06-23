import { describe, it, expect } from "vitest";
import { compileEngineWithMetrics } from "../src/context-engine/engine-compiler.js";
import { scoreContextUnit } from "../src/context-engine/scoring.js";
import type { ContextEngineConfig } from "../src/types.js";
import type { ContextUnit } from "../src/context-engine/types.js";

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
    const unit: ContextUnit = {
      id: "turn_3",
      type: "turn_digest",
      content: "fixed authentication login endpoint returning 401 error",
      tokens: 50,
      sourceTurn: 3,
      score: 0,
      pinned: false,
      artifactRefs: [],
    };
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
      turnRecords: [{ turn: 3, userMessage: "fix auth", assistantMessage: "done", toolCalls: [], artifactIds: [], filesRead: [], filesWritten: [], errors: [], tokenCount: 50, timestamp: 1 }],
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
      turnRecords: [{ turn: 3, userMessage: "fix auth", assistantMessage: "done", toolCalls: [], artifactIds: [], filesRead: [], filesWritten: [], errors: [], tokenCount: 50, timestamp: 1 }],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
      hydratedTexts: ["Fix authentication login bug — endpoint returning 401"],
    });
    const basePick = baseResult.scoreRecords.find((r) => r.unitId.includes("turn"));
    const boostedPick = boostedResult.scoreRecords.find((r) => r.unitId.includes("turn"));
    if (basePick && boostedPick) {
      expect(boostedPick.breakdown.hydrate_boost).toBeGreaterThan(0);
      expect(boostedPick.score).toBeGreaterThan(basePick.score);
    }
  });
});
