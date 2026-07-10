import { describe, expect, it } from "bun:test";
import {
  buildContextDisplaySnapshot,
  computeDistillerSavings,
  contextPct,
  estimateAssistantMessageTokens,
  maxContextSnapshot,
  mergeContextPreview,
  shouldShowRawParenthetical,
} from "../src/context-display.js";
import type { Session } from "../src/session.js";

function mockSession(overrides: Partial<Session> = {}): Session {
  return {
    getLastCompileMetrics: () => ({
      totalTokens: 40_000,
      systemFrameTokens: 0,
      agentsContextTokens: 0,
      skillsCatalogTokens: 0,
      checkpointTokens: 0,
      crossSessionTokens: 0,
      activeStateTokens: 0,
      peripheralStubsTokens: 0,
      recentTurnsTokens: 0,
      currentInputTokens: 0,
      activeObjectCount: 0,
      peripheralObjectCount: 0,
      recentTurnsTruncated: false,
      memoryTruncated: false,
      agentsContextTruncated: false,
      skillsTruncated: false,
    }),
    getLastWeightedTokens: () => 14_000,
    getLastPressureMode: () => "compact" as const,
    getDisplayContextSnapshot: () => null,
    ...overrides,
  } as unknown as Session;
}

describe("context-display", () => {
  it("computes classic snapshot from raw compile tokens plus history", () => {
    const snapshot = buildContextDisplaySnapshot({
      session: mockSession(),
      contextWindowTokens: 100_000,
      engineMode: false,
      historyTokens: 5_000,
    });
    expect(snapshot.mode).toBe("classic");
    expect(snapshot.usedTokens).toBe(45_000);
    expect(snapshot.pct).toBe(45);
  });

  it("computes engine snapshot with weighted system base plus history", () => {
    const snapshot = buildContextDisplaySnapshot({
      session: mockSession(),
      contextWindowTokens: 100_000,
      engineMode: true,
      historyTokens: 5_000,
    });
    expect(snapshot.mode).toBe("engine");
    expect(snapshot.usedTokens).toBe(19_000);
    expect(snapshot.weightedPct).toBe(19);
    expect(snapshot.rawTokens).toBe(45_000);
    expect(snapshot.rawPct).toBe(45);
    expect(snapshot.pressureMode).toBe("compact");
  });

  it("shows raw parenthetical only when divergence exceeds threshold", () => {
    expect(shouldShowRawParenthetical(14, 41)).toBe(true);
    expect(shouldShowRawParenthetical(40, 45)).toBe(false);
  });

  it("merges preview monotonically with accumulated history", () => {
    const baseline = buildContextDisplaySnapshot({
      session: mockSession(),
      contextWindowTokens: 100_000,
      engineMode: true,
      historyTokens: 1_000,
    });
    const next = mergeContextPreview(baseline, 8_000, 2_000, true);
    expect(next.usedTokens).toBeGreaterThan(baseline.usedTokens);
    expect(next.historyTokens).toBe(8_000);
    expect(next.distillerSavingsTurn).toBe(2_000);
  });

  it("estimates assistant messages with thinking blocks", () => {
    const tokens = estimateAssistantMessageTokens({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan the refactor" },
        { type: "text", text: "Done." },
      ],
    });
    expect(tokens).toBeGreaterThan(0);
  });

  it("computes distiller savings for artifact cards", () => {
    const savings = computeDistillerSavings("x".repeat(4000), "summary", false);
    expect(savings).toBeGreaterThan(0);
    expect(computeDistillerSavings("small", "small", true)).toBe(0);
  });

  it("caps context percent at 100", () => {
    expect(contextPct(200_000, 100_000)).toBe(100);
  });

  it("maxContextSnapshot keeps the higher live preview for commit", () => {
    const built = buildContextDisplaySnapshot({
      session: mockSession(),
      contextWindowTokens: 100_000,
      engineMode: true,
      historyTokens: 1_000,
    });
    const live = mergeContextPreview(built, 8_000, 0, true);
    const committed = maxContextSnapshot(built, live);
    expect(committed.usedTokens).toBe(live.usedTokens);
    expect(committed.pct).toBe(live.pct);
  });
});
