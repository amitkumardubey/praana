import { describe, it, expect } from "vitest";
import { MemoryStore, HashEmbedder } from "../src/memory/index.js";
import {
  openMemoryDb,
  insertEntry,
  upsertEmbedding,
  deleteEntry,
} from "../src/memory/db.js";

describe("Memory safety", () => {
  it("does not recall memories from a different context by default", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new HashEmbedder(),
    });

    const base = {
      agent: "aria-test",
      user_id: "u1",
      time: Date.now(),
      context_label: "test",
    };

    await store.sessionStart({ ...base, context_id: "ctx-a" });
    await store.remember("ctx-a only: migrate the checkout schema", {
      kind: "fact",
      certainty: "high",
    });

    // Ensure fire-and-forget embedding write has completed.
    await new Promise((r) => setTimeout(r, 5));

    await store.sessionStart({ ...base, context_id: "ctx-b" });
    const result = await store.recall("migrate the checkout schema", { limit: 10 });

    expect(
      result.entries.some((e) => e.content.includes("ctx-a only"))
    ).toBe(false);

    store.close();
  });

  it("deleteEntry removes only the target vector row", async () => {
    const { db } = openMemoryDb(":memory:");
    const now = Date.now();

    insertEntry(db, {
      id: "e1",
      kind: "fact",
      content: "first entry",
      confidence: 0.5,
      pinned: false,
      created_at: now,
      last_seen_at: now,
      session_id: "s1",
      scopes: ["context:a"],
    });

    insertEntry(db, {
      id: "e2",
      kind: "fact",
      content: "second entry",
      confidence: 0.5,
      pinned: false,
      created_at: now,
      last_seen_at: now,
      session_id: "s1",
      scopes: ["context:a"],
    });

    const v1 = new Float32Array(384);
    v1[0] = 1;
    const v2 = new Float32Array(384);
    v2[1] = 1;

    upsertEmbedding(db, "e1", v1);
    upsertEmbedding(db, "e2", v2);

    deleteEntry(db, "e2");

    const remainingIds = db
      .prepare("SELECT entry_id FROM entries_vec ORDER BY entry_id")
      .all() as Array<{ entry_id: string }>;

    expect(remainingIds.map((r) => r.entry_id)).toEqual(["e1"]);

    db.close();
  });
});
