import { describe, it, expect, spyOn } from "bun:test";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import { MemoryStore } from "../src/memory/index.js";

describe("memory pruning", () => {
  it("removes stale low-confidence Layer 1 entries at session start", async () => {
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
    await store.remember("Old stale fact", { kind: "fact", certainty: "low" });
    await store.sessionEnd("clean");

    const staleId = store.getAllEntries()[0].id;
    const staleLastSeen = Date.now() - 31 * 86_400_000;
    store["db"]
      .prepare("UPDATE entries SET last_seen_at = ?, validity = 0.05, created_at = ? WHERE id = ?")
      .run(staleLastSeen, staleLastSeen, staleId);

    await store.sessionStart(ctx);
    expect(store.getAllEntries()).toHaveLength(0);
  });

  it("never prunes pinned or Layer 2 entries", async () => {
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
    await store.remember("Pinned rule", { kind: "constraint", certainty: "low", pinned: true });
    await store.remember("Deep memory", { kind: "fact", certainty: "low" });
    await store.sessionEnd("clean");

    const staleLastSeen = Date.now() - 31 * 86_400_000;
    for (const entry of store.getAllEntries()) {
      store["db"]
        .prepare("UPDATE entries SET last_seen_at = ?, validity = 0.1, layer = ? WHERE id = ?")
        .run(staleLastSeen, entry.content === "Deep memory" ? 2 : 1, entry.id);
    }

    await store.sessionStart(ctx);
    expect(store.getAllEntries()).toHaveLength(2);
  });

  it("retains stale entries that are still highly valid", async () => {
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
    await store.remember("Cold but true", { kind: "fact", certainty: "high" });

    const entry = store.getAllEntries()[0];
    const staleLastSeen = Date.now() - 31 * 86_400_000;

    store["db"]
      .prepare("UPDATE entries SET last_seen_at = ?, validity = 0.9, usefulness = 0.1 WHERE id = ?")
      .run(staleLastSeen, entry.id);

    const pruned = await store.prune();

    expect(pruned).toBe(0);
    expect(store.getAllEntries()).toHaveLength(1);
  });

  it("retains stale entries with moderate validity between thresholds", async () => {
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
    await store.remember("Moderate validity, stale", { kind: "fact", certainty: "medium" });

    const entry = store.getAllEntries()[0];
    const staleLastSeen = Date.now() - 31 * 86_400_000;

    // Validity 0.3 is below the retain-gate (0.7) but above the old <0.05 threshold.
    // These mid-validity entries are kept — the retain-gate adds a hard floor at 0.7
    // for cold-but-valid entries, but the deletion floor stays at 0.05.
    store["db"]
      .prepare("UPDATE entries SET last_seen_at = ?, validity = 0.3 WHERE id = ?")
      .run(staleLastSeen, entry.id);

    const pruned = await store.prune();

    expect(pruned).toBe(0);
    expect(store.getAllEntries()).toHaveLength(1);
  });

  it("prunes stale entries with very low validity below 0.05", async () => {
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
    await store.remember("Very low validity, stale", { kind: "fact", certainty: "low" });

    const entry = store.getAllEntries()[0];
    const staleLastSeen = Date.now() - 31 * 86_400_000;

    // Validity 0.04 is below the old 0.05 threshold — should be pruned.
    store["db"]
      .prepare("UPDATE entries SET last_seen_at = ?, validity = 0.04 WHERE id = ?")
      .run(staleLastSeen, entry.id);

    const pruned = await store.prune();

    expect(pruned).toBe(1);
    expect(store.getAllEntries()).toHaveLength(0);
  });

  it("triggers prune when entry count crosses the growth threshold", async () => {
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

    const pruneSpy = spyOn(store, "prune").mockResolvedValue(0);
    const now = Date.now();
    const insert = store["db"].prepare(`
      INSERT INTO entries (
        id, kind, content, validity, usefulness, pinned, layer,
        confirmation_count, created_at, last_seen_at, session_id
      ) VALUES (?, 'fact', ?, 0.5, 0.5, 0, 1, 0, ?, ?, ?)
    `);

    const tx = store["db"].transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        const ts = now - i;
        insert.run(`seed-${i}`, `Seed ${i}`, ts, ts, "previous-session");
      }
    });
    tx(1000);

    await store.remember("Trigger prune", { kind: "fact", certainty: "low" });

    expect(pruneSpy).toHaveBeenCalledTimes(1);
  });
});
