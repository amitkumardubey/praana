import { describe, expect, it } from "bun:test";
import { compareTurn } from "../../src/benchmark/comparison.js";
import type { ReplayTurn } from "../../src/benchmark/session-replay.js";
import type { ContextEngineConfig } from "../../src/types.js";

const mockConfig: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 400,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: {
    w_recency: 0.3,
    w_relevance: 0.5,
    w_pin: 0.1,
    w_hydrate_boost: 0.1,
    w_semantic: 0,
  },
  pressure: {
    compact_at: 0.8,
    emergency_at: 0.95,
  },
};

describe("compareTurn", () => {
  it("should produce valid comparison for simple session", async () => {
    const turns: ReplayTurn[] = [
      {
        turnNumber: 1,
        userMessage: "fix the bug in auth.ts",
        assistantMessage: "I'll look into it",
        toolCalls: [{ tool: "read_file", args: { path: "auth.ts" }, isError: false, resultText: "auth code" }],
        filesRead: ["auth.ts"],
        filesWritten: [],
        errors: [],
      },
      {
        turnNumber: 2,
        userMessage: "now test it",
        assistantMessage: "running tests",
        toolCalls: [{ tool: "shell", args: { command: "bun test" }, isError: false, resultText: "all pass" }],
        filesRead: [],
        filesWritten: [],
        errors: [],
      },
    ];

    const comparison = await compareTurn(turns, 2, "/test", "session-1", mockConfig);
    expect(comparison.engine.totalTokens).toBeGreaterThan(0);
    expect(comparison.classic.totalTokens).toBeGreaterThan(0);
    expect(comparison.tokenRatio).toBeGreaterThan(0);
    expect(comparison.tokenRatio).toBeLessThanOrEqual(2); // Should not be wildly larger
    expect(comparison.compressionEfficiency).toBeGreaterThanOrEqual(-1); // Can be negative if engine is larger
    expect(comparison.compressionEfficiency).toBeLessThanOrEqual(1);
  });

  it("should track pressure mode", async () => {
    const turns: ReplayTurn[] = [
      {
        turnNumber: 1,
        userMessage: "hello",
        assistantMessage: "hi",
        toolCalls: [],
        filesRead: [],
        filesWritten: [],
        errors: [],
      },
    ];

    const comparison = await compareTurn(turns, 1, "/test", "session-2", mockConfig);
    expect(comparison.engine.pressureMode).toBeDefined();
  });
});
