import { describe, it, expect, vi } from "vitest";
import type { ConsolidationConfig, ConsolidationResult } from "../src/memory/consolidation.js";

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
      getConsolidationCandidates: vi.fn().mockReturnValue([]),
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
      getConsolidationCandidates: vi.fn().mockReturnValue([]),
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
      validity: 0.7,
      usefulness: 0.5,
      pinned: false,
      layer: 1,
      confirmation_count: 2,
      created_at: Date.now(),
      last_seen_at: Date.now(),
      session_id: "test",
      scopes: ["context:test"],
      retracted: false,
    };

    const entry2 = {
      id: "entry-2",
      kind: "pattern",
      content: "Validates with Zod before DB writes",
      validity: 0.5,
      usefulness: 0.5,
      pinned: false,
      layer: 1,
      confirmation_count: 1,
      created_at: Date.now(),
      last_seen_at: Date.now(),
      session_id: "test",
      scopes: ["context:test"],
      retracted: false,
    };

    const store = {
      getConsolidationCandidates: vi.fn().mockReturnValue([entry1, entry2]),
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
      validity: 0.4, // Below 0.6 threshold
      usefulness: 0.5,
      pinned: false,
      layer: 1,
      confirmation_count: 2, // Below 3 threshold
      created_at: Date.now(),
      last_seen_at: Date.now(),
      session_id: "test",
      scopes: ["context:test"],
      retracted: false,
    };

    const entryAboveThreshold = {
      id: "entry-high",
      kind: "fact",
      content: "Confirmed fact",
      validity: 0.8,
      usefulness: 0.5,
      pinned: false,
      layer: 1,
      confirmation_count: 5, // Above 3 threshold
      created_at: Date.now(),
      last_seen_at: Date.now(),
      session_id: "test",
      scopes: ["context:test"],
      retracted: false,
    };

    const store = {
      getConsolidationCandidates: vi.fn().mockReturnValue([entryBelowThreshold, entryAboveThreshold]),
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

  it("selects surfaced, new, and aging Layer 1 entries for consolidation", async () => {
    const { MemoryStore } = await import("../src/memory/index.js");
    const { DeterministicTestEmbedder } = await import("./helpers/test-embedder.js");

    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });

    const ctx = {
      agent: "praana",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    };

    await store.sessionStart(ctx);
    await store.remember("Aging candidate", { kind: "fact", certainty: "low" });
    await store.remember("Fresh surfaced candidate", { kind: "fact", certainty: "low" });
    await store.remember("Fresh new candidate", { kind: "fact", certainty: "low" });
    await store.recall("Fresh surfaced candidate", { limit: 1 });

    const now = Date.now();
    const oldEnough = now - 31 * 86_400_000;
    const recentEnough = now - 10 * 86_400_000;

    const agedId = store.getAllEntries().find((e) => e.content === "Aging candidate")?.id;
    const freshSurfacedId = store.getAllEntries().find((e) => e.content === "Fresh surfaced candidate")?.id;
    const freshNewId = store.getAllEntries().find((e) => e.content === "Fresh new candidate")?.id;

    if (!agedId || !freshSurfacedId || !freshNewId) {
      throw new Error("Test setup failed");
    }

    store["db"]
      .prepare("UPDATE entries SET last_seen_at = ?, session_id = ? WHERE id = ?")
      .run(oldEnough, "previous-session", agedId);
    store["db"]
      .prepare("UPDATE entries SET last_seen_at = ?, session_id = ? WHERE id = ?")
      .run(recentEnough, "previous-session", freshSurfacedId);

    const candidates = store.getConsolidationCandidates(now);
    const ids = candidates.map((entry) => entry.id);
    const contents = candidates.map((entry) => entry.content);

    expect(ids[0]).toBe(freshSurfacedId);
    expect(new Set(ids)).toEqual(new Set([freshSurfacedId, freshNewId, agedId]));
    expect(new Set(contents)).toEqual(new Set([
      "Fresh surfaced candidate",
      "Fresh new candidate",
      "Aging candidate",
    ]));
  });

  it("uses the MemoryStore session id when consolidation receives an outer session id", async () => {
    const { runConsolidation } = await import("../src/memory/consolidation.js");
    const { MemoryStore } = await import("../src/memory/index.js");
    const { DeterministicTestEmbedder } = await import("./helpers/test-embedder.js");

    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });

    await store.sessionStart({
      agent: "praana",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    });
    await store.remember("Current session candidate", { kind: "fact", certainty: "low" });

    let prompt = "";
    const llm = {
      name: "test-llm",
      available: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockImplementation(async (req) => {
        prompt = req.prompt;
        return JSON.stringify({
          confirmations: [],
          contradictions: [],
          new_entries: [],
          promotions: [],
        });
      }),
    };

    await runConsolidation({
      store,
      llm,
      sessionId: "outer-event-log-session",
      events: [{ type: "user_message", timestamp: Date.now(), content: "hello" }],
      config: { enabled: true, promotion_threshold: 3, run_delay_seconds: 0 },
    });

    expect(prompt).toContain("Current session candidate");
  });

  it("caps consolidation candidates at 50 entries", async () => {
    const { MemoryStore } = await import("../src/memory/index.js");
    const { DeterministicTestEmbedder } = await import("./helpers/test-embedder.js");

    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });

    const ctx = {
      agent: "praana",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    };

    await store.sessionStart(ctx);

    for (let i = 0; i < 51; i++) {
      await store.remember(`Candidate ${i}`, { kind: "fact", certainty: "low" });
    }

    const candidates = store.getConsolidationCandidates(Date.now());

    expect(candidates).toHaveLength(50);
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
