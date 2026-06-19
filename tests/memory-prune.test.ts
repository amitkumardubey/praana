import { describe, it, expect } from "vitest";
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
});
