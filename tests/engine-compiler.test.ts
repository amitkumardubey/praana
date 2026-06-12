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
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
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
});
