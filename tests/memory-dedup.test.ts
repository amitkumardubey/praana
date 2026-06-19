import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import { MemoryStore } from "../src/memory/index.js";
import type { SummarizerLLM } from "../src/memory/types.js";
import { heuristicContradiction, extractHeadNoun, cosineSimilarity } from "../src/memory/dedup.js";
import { DEDUP_RECONCILED_KEY, getMemoryMeta, insertEntry, upsertEmbedding } from "../src/memory/db.js";
import { ulid } from "ulid";

function storeDb(store: MemoryStore): Database.Database {
  return (store as MemoryStore & { db: Database.Database }).db;
}

describe("extractHeadNoun", () => {
  it("extracts primary noun from simple statement", () => {
    expect(extractHeadNoun("Streaming is implemented")).toBe("streaming");
  });

  it("extracts first noun when multiple nouns present", () => {
    const result = extractHeadNoun("Project uses PostgreSQL");
    expect(result).toMatch(/^(project|postgresql)$/); // Either is acceptable
  });

  it("handles negation patterns", () => {
    expect(extractHeadNoun("No database configured")).toBe("database");
  });

  it("returns null for empty input", () => {
    expect(extractHeadNoun("")).toBe(null);
    expect(extractHeadNoun("   ")).toBe(null);
  });

  it("returns null when no nouns found", () => {
    expect(extractHeadNoun("is not")).toBe(null);
  });

  it("normalizes extracted noun", () => {
    // "database" is the head noun; "PostgreSQL" is a modifier
    expect(extractHeadNoun("The PostgreSQL database")).toBe("database");
  });
});

describe("heuristicContradiction - M7 Layer 1 subject-aware", () => {
  it("detects contradiction when same subject has opposite polarity", () => {
    expect(
      heuristicContradiction(
        "Streaming is implemented in turn.ts",
        "Streaming is not implemented in turn.ts"
      )
    ).toBe(true);
  });

  it("does NOT flag as contradictory when different subjects (PostgreSQL vs MongoDB)", () => {
    expect(
      heuristicContradiction(
        "Project uses PostgreSQL",
        "Project uses MongoDB"
      )
    ).toBe(false);
  });

  it("does NOT flag different subjects with negation", () => {
    expect(
      heuristicContradiction(
        "Caching is enabled",
        "Logging is not disabled"
      )
    ).toBe(false);
  });

  it("detects contradiction with ≥3 shared terms + shared noun", () => {
    expect(
      heuristicContradiction(
        "The memory store uses a hash table",
        "The memory store does not use a hash table"
      )
    ).toBe(true);
  });

  it("does NOT detect contradiction with same polarity", () => {
    expect(
      heuristicContradiction(
        "Tests use Vitest",
        "Tests use Playwright"
      )
    ).toBe(false);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns correct similarity for known vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    // dot=32, normA=√14, normB=√77 → 32/(√14*√77) ≈ 0.9746
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.97);
    expect(sim).toBeLessThan(0.98);
  });

  it("returns 0 for mismatched dimensions", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("handles zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe("sessionEnd duplicate and contradiction detection", () => {
  const ctx = {
    agent: "praana",
    user_id: "u1",
    time: Date.now(),
    context_id: "ctx1",
    context_label: "test",
  };

  it("reinforces existing entry instead of storing duplicate", async () => {
    const summarizer: SummarizerLLM = {
      name: "test",
      available: async () => true,
      complete: async () =>
        JSON.stringify([
          {
            kind: "fact",
            content: "Project uses Vitest for testing",
            certainty: "high",
          },
        ]),
    };

    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
      summarizer,
    });

    await store.sessionStart(ctx);
    await store.remember("Project uses Vitest for testing", {
      kind: "fact",
      certainty: "high",
    });
    const before = store.getAllEntries()[0].validity;
    await store.sessionEnd("clean", [
      { type: "user_message", timestamp: Date.now(), content: "tests" },
    ]);

    expect(store.getAllEntries()).toHaveLength(1);
    expect(store.getAllEntries()[0].validity).toBeGreaterThan(before);
  });

  it("weakens contradictory entry before storing new learning", async () => {
    expect(
      heuristicContradiction(
        "Streaming is implemented in turn.ts",
        "Streaming is not implemented in turn.ts",
      ),
    ).toBe(true);

    const summarizer: SummarizerLLM = {
      name: "test",
      available: async () => true,
      complete: async () =>
        JSON.stringify([
          {
            kind: "fact",
            content: "Streaming is not implemented in turn.ts",
            certainty: "high",
          },
        ]),
    };

    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
      summarizer,
    });

    await store.sessionStart(ctx);
    await store.remember("Streaming is implemented in turn.ts", {
      kind: "fact",
      certainty: "high",
    });
    const beforeConf = store.getAllEntries()[0].validity;
    await store.sessionEnd("clean", [
      { type: "user_message", timestamp: Date.now(), content: "streaming" },
    ]);

    const entries = store.getAllEntries();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const weakened = entries.find(
      (e) => e.content.includes("implemented in turn.ts") && !e.content.includes("not"),
    );
    expect(weakened?.validity).toBeLessThan(beforeConf);
  });
});

describe("M7 edge cases - comprehensive contradiction detection", () => {
  it("does NOT flag partial overlaps as contradictory", () => {
    expect(
      heuristicContradiction(
        "Tests use Vitest for unit tests",
        "Integration tests use Playwright"
      )
    ).toBe(false);
  });

  it("does NOT flag different features with opposite states", () => {
    expect(
      heuristicContradiction(
        "Feature A is enabled",
        "Feature B is not enabled"
      )
    ).toBe(false);
  });

  it("detects contradiction for clear opposite statements", () => {
    expect(
      heuristicContradiction(
        "API endpoint returns JSON",
        "API endpoint does not return JSON"
      )
    ).toBe(true);
  });

  it("does NOT flag technology comparisons as contradictory", () => {
    expect(
      heuristicContradiction(
        "Frontend uses React",
        "Backend does not use React"
      )
    ).toBe(false);
  });

  it("handles statements with similar structure but different subjects", () => {
    expect(
      heuristicContradiction(
        "The compiler validates types",
        "The runtime does not validate types"
      )
    ).toBe(false);
  });
});

describe("remember() duplicate detection", () => {
  const ctx = {
    agent: "praana",
    user_id: "u1",
    time: Date.now(),
    context_id: "ctx1",
    context_label: "test",
  };

  it("reinforces instead of inserting when content is a near-duplicate", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
      summarizer: null,
    });

    await store.sessionStart(ctx);
    const first = await store.remember("The project uses Vitest for testing.", {
      kind: "fact",
      certainty: "high",
    });
    const second = await store.remember("The project uses Vitest for testing!", {
      kind: "fact",
      certainty: "high",
    });

    expect(store.getAllEntries()).toHaveLength(1);
    expect(first.reinforced).toBeUndefined();
    expect(second.reinforced).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("does not dedup across different context scopes", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
      summarizer: null,
    });

    await store.sessionStart(ctx);
    await store.remember("Shared project fact", {
      kind: "fact",
      scope: ["user:u1", "agent:praana", "context:ctx1"],
    });
    await store.remember("Shared project fact", {
      kind: "fact",
      scope: ["user:u1", "agent:praana", "context:ctx2"],
    });

    expect(store.getAllEntries()).toHaveLength(2);
  });
});

describe("reconcileDuplicates()", () => {
  const scopes = ["user:u1", "agent:praana", "context:ctx1"];

  it("merges three identical entries into one", async () => {
    const embedder = new DeterministicTestEmbedder();
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder,
      summarizer: null,
    });

    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const id = ulid();
      insertEntry(storeDb(store), {
        id,
        kind: "fact",
        content: "The project uses Vitest for testing.",
        validity: 0.7 + i * 0.05,
        usefulness: 0.5,
        pinned: false,
        layer: 1,
        confirmation_count: i,
        created_at: now + i,
        last_seen_at: now + i,
        session_id: "s1",
        scopes,
        retracted: false,
      });
      const vec = await embedder.embed("The project uses Vitest for testing.");
      upsertEmbedding(storeDb(store), id, vec);
    }

    const result = await store.reconcileDuplicates();
    expect(result.clustersMerged).toBe(1);
    expect(result.entriesRemoved).toBe(2);
    expect(store.getAllEntries()).toHaveLength(1);
    expect(store.getAllEntries()[0].confirmation_count).toBeGreaterThan(0);
  });

  it("runs once automatically on session start for unreconciled databases", async () => {
    const embedder = new DeterministicTestEmbedder();
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder,
      summarizer: null,
    });

    const now = Date.now();
    for (const content of [
      "Tests cover compiler and tools",
      "Tests cover compiler and tools.",
    ]) {
      const id = ulid();
      insertEntry(storeDb(store), {
        id,
        kind: "fact",
        content,
        validity: 0.8,
        usefulness: 0.5,
        pinned: false,
        layer: 1,
        confirmation_count: 0,
        created_at: now,
        last_seen_at: now,
        session_id: "s1",
        scopes,
        retracted: false,
      });
    }

    await store.sessionStart({
      agent: "praana",
      user_id: "u1",
      time: now,
      context_id: "ctx1",
      context_label: "test",
    });

    expect(store.getAllEntries()).toHaveLength(1);
    expect(getMemoryMeta(storeDb(store), DEDUP_RECONCILED_KEY)).toBe("1");
  });
});
