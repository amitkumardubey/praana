import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import { MemoryStore } from "../src/memory/index.js";
import type { SummarizerLLM } from "../src/memory/types.js";
import { heuristicContradiction } from "../src/memory/dedup.js";
import { DEDUP_RECONCILED_KEY, getMemoryMeta, insertEntry, upsertEmbedding } from "../src/memory/db.js";
import { ulid } from "ulid";

function storeDb(store: MemoryStore): Database.Database {
  return (store as MemoryStore & { db: Database.Database }).db;
}

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
    const before = store.getAllEntries()[0].confidence;
    await store.sessionEnd("clean", [
      { type: "user_message", timestamp: Date.now(), content: "tests" },
    ]);

    expect(store.getAllEntries()).toHaveLength(1);
    expect(store.getAllEntries()[0].confidence).toBeGreaterThan(before);
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
    const beforeConf = store.getAllEntries()[0].confidence;
    await store.sessionEnd("clean", [
      { type: "user_message", timestamp: Date.now(), content: "streaming" },
    ]);

    const entries = store.getAllEntries();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const weakened = entries.find(
      (e) => e.content.includes("implemented in turn.ts") && !e.content.includes("not"),
    );
    expect(weakened?.confidence).toBeLessThan(beforeConf);
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
        confidence: 0.7 + i * 0.05,
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
        confidence: 0.8,
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
