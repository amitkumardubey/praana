import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConsolidationConfig, ConsolidationResult } from "../src/memory/consolidation.js";

// Mock the memory store
vi.mock("../src/memory/store.js", () => ({
  MemoryStore: vi.fn().mockImplementation(() => ({
    getAllEntries: vi.fn().mockReturnValue([]),
    reinforceFromSuccessfulToolOutcome: vi.fn(),
    weakenEntry: vi.fn(),
    promoteToLayer2: vi.fn(),
    remember: vi.fn().mockResolvedValue({ id: "new-entry" }),
  })),
}));

// Mock the summarizer LLM
function createMockLLM(response: string) {
  return {
    name: "test-llm",
    available: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(response),
  };
}

describe("consolidation processor", () => {
  it("exists and is importable", async () => {
    const { runConsolidation } = await import("../src/memory/consolidation.js");
    expect(typeof runConsolidation).toBe("function");
  });

  it("returns empty result when disabled", async () => {
    const { runConsolidation } = await import("../src/memory/consolidation.js");
    const store = {
      getAllEntries: vi.fn().mockReturnValue([]),
      reinforceFromSuccessfulToolOutcome: vi.fn(),
      weakenEntry: vi.fn(),
      promoteToLayer2: vi.fn(),
      remember: vi.fn(),
    } as any;
    const llm = createMockLLM("{}");

    const result = await runConsolidation({
      store,
      llm,
      sessionId: "test",
      events: [{ type: "user_message", timestamp: Date.now(), content: "hello" }],
      config: { enabled: false, promotion_threshold: 3, run_delay_seconds: 0 },
    });

    expect(result.promotions).toBe(0);
    expect(result.confirmations).toBe(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("returns empty result when no events", async () => {
    const { runConsolidation } = await import("../src/memory/consolidation.js");
    const store = {
      getAllEntries: vi.fn().mockReturnValue([]),
      reinforceFromSuccessfulToolOutcome: vi.fn(),
      weakenEntry: vi.fn(),
      promoteToLayer2: vi.fn(),
      remember: vi.fn(),
    } as any;
    const llm = createMockLLM("{}");

    const result = await runConsolidation({
      store,
      llm,
      sessionId: "test",
      events: [],
      config: { enabled: true, promotion_threshold: 3, run_delay_seconds: 0 },
    });

    expect(result.promotions).toBe(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("processes consolidation result correctly", async () => {
    const { runConsolidation } = await import("../src/memory/consolidation.js");

    const entry1 = {
      id: "entry-1",
      kind: "fact",
      content: "Uses Vitest for testing",
      confidence: 0.7,
      pinned: false,
      layer: 1,
      confirmation_count: 2,
      created_at: Date.now(),
      last_seen_at: Date.now(),
      session_id: "test",
      scopes: ["context:test"],
    };

    const entry2 = {
      id: "entry-2",
      kind: "pattern",
      content: "Validates with Zod before DB writes",
      confidence: 0.5,
      pinned: false,
      layer: 1,
      confirmation_count: 1,
      created_at: Date.now(),
      last_seen_at: Date.now(),
      session_id: "test",
      scopes: ["context:test"],
    };

    const store = {
      getAllEntries: vi.fn().mockReturnValue([entry1, entry2]),
      reinforceFromSuccessfulToolOutcome: vi.fn(),
      weakenEntry: vi.fn(),
      promoteToLayer2: vi.fn(),
      remember: vi.fn().mockResolvedValue({ id: "new-entry" }),
    } as any;

    const consolidationResponse = JSON.stringify({
      confirmations: ["entry-1"],
      contradictions: ["entry-2"],
      new_entries: [
        { kind: "fact", content: "Uses TypeScript strict mode", certainty: "high" },
      ],
      promotions: ["entry-1"],
    });

    const llm = createMockLLM(consolidationResponse);

    const result = await runConsolidation({
      store,
      llm,
      sessionId: "test",
      events: [{ type: "user_message", timestamp: Date.now(), content: "hello" }],
      config: { enabled: true, promotion_threshold: 3, run_delay_seconds: 0 },
    });

    expect(result.confirmations).toBe(1);
    expect(result.contradictions).toBe(1);
    expect(result.newEntries).toBe(1);
    expect(store.reinforceFromSuccessfulToolOutcome).toHaveBeenCalledWith(["entry-1"], 0.1);
    expect(store.weakenEntry).toHaveBeenCalledWith("entry-2", 0.2);
    expect(store.remember).toHaveBeenCalledWith("Uses TypeScript strict mode", {
      kind: "fact",
      certainty: "high",
    });
  });

  it("only promotes entries meeting threshold criteria", async () => {
    const { runConsolidation } = await import("../src/memory/consolidation.js");

    const entryBelowThreshold = {
      id: "entry-low",
      kind: "fact",
      content: "Some fact",
      confidence: 0.4, // Below 0.6 threshold
      pinned: false,
      layer: 1,
      confirmation_count: 2, // Below 3 threshold
      created_at: Date.now(),
      last_seen_at: Date.now(),
      session_id: "test",
      scopes: ["context:test"],
    };

    const entryAboveThreshold = {
      id: "entry-high",
      kind: "fact",
      content: "Confirmed fact",
      confidence: 0.8,
      pinned: false,
      layer: 1,
      confirmation_count: 5, // Above 3 threshold
      created_at: Date.now(),
      last_seen_at: Date.now(),
      session_id: "test",
      scopes: ["context:test"],
    };

    const store = {
      getAllEntries: vi.fn().mockReturnValue([entryBelowThreshold, entryAboveThreshold]),
      reinforceFromSuccessfulToolOutcome: vi.fn(),
      weakenEntry: vi.fn(),
      promoteToLayer2: vi.fn(),
      remember: vi.fn(),
    } as any;

    const consolidationResponse = JSON.stringify({
      confirmations: [],
      contradictions: [],
      new_entries: [],
      promotions: ["entry-low", "entry-high"], // Both requested, but only one qualifies
    });

    const llm = createMockLLM(consolidationResponse);

    const result = await runConsolidation({
      store,
      llm,
      sessionId: "test",
      events: [{ type: "user_message", timestamp: Date.now(), content: "hello" }],
      config: { enabled: true, promotion_threshold: 3, run_delay_seconds: 0 },
    });

    // Only entry-high should be promoted
    expect(store.promoteToLayer2).toHaveBeenCalledTimes(1);
    expect(store.promoteToLayer2).toHaveBeenCalledWith("entry-high");
    expect(result.promotions).toBe(1);
  });
});

describe("ConsolidationConfig", () => {
  it("has correct default values", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.consolidation).toBeDefined();
    expect(config.consolidation.enabled).toBe(true);
    expect(config.consolidation.promotion_threshold).toBe(3);
    expect(config.consolidation.run_delay_seconds).toBe(30);
  });
});
