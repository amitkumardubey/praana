import { describe, it, expect } from "vitest";
import { MemoryStore, HashEmbedder, type Embedder } from "../src/memory/index.js";
import {
  openMemoryDb,
  insertEntry,
  upsertEmbedding,
  deleteEntry,
} from "../src/memory/db.js";

class ThrowingEmbedder implements Embedder {
  dim = 384;

  async embed(): Promise<Float32Array> {
    throw new Error("embedding unavailable");
  }
}

describe("Memory safety", () => {
  it("rejects invalid memory kinds at write time", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new HashEmbedder(),
    });

    await store.sessionStart({
      agent: "aria-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx-a",
      context_label: "test",
    });

    await expect(
      store.remember("invalid kind write", {
        kind: "bug" as any,
      }),
    ).rejects.toThrow("Invalid memory kind");

    store.close();
  });

  it("prioritizes keyword matches over unrelated vector candidates", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new HashEmbedder(),
    });

    await store.sessionStart({
      agent: "aria-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx-a",
      context_label: "test",
    });

    await store.remember("User's name is Amit", {
      kind: "fact",
      certainty: "medium",
    });
    await store.remember("Deployment pipeline uses GitHub Actions", {
      kind: "fact",
      certainty: "high",
    });

    const result = await store.recall("name", { limit: 1 });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("User's name is Amit");

    store.close();
  });

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

    await store.sessionStart({ ...base, context_id: "ctx-b" });
    const result = await store.recall("migrate the checkout schema", { limit: 10 });

    expect(
      result.entries.some((e) => e.content.includes("ctx-a only"))
    ).toBe(false);

    store.close();
  });

  it("recalls both project and global memories in a project-scoped session", async () => {
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
    await store.remember("global note: always prefer strict mode", {
      kind: "fact",
      certainty: "high",
      scope: ["user:u1", "agent:aria-test"],
    });
    await store.remember("project note: checkout schema migration", {
      kind: "fact",
      certainty: "high",
    });

    const result = await store.recall("note", { limit: 10 });
    const contents = result.entries.map((e) => e.content);

    expect(contents).toContain("global note: always prefer strict mode");
    expect(contents).toContain("project note: checkout schema migration");

    store.close();
  });

  it("includes global memories in digest for project-scoped session start", async () => {
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
    await store.remember("global preference: keep answers concise", {
      kind: "preference",
      certainty: "high",
      scope: ["user:u1", "agent:aria-test"],
    });
    await store.sessionEnd("clean");

    const digest = await store.sessionStart({ ...base, context_id: "ctx-b" });
    expect(digest.markdown).toContain("global preference: keep answers concise");

    store.close();
  });

  it("finds scoped FTS matches even when unscoped matches exceed the candidate limit", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new ThrowingEmbedder(),
    });

    const base = {
      agent: "aria-test",
      user_id: "u1",
      time: Date.now(),
      context_label: "test",
    };

    await store.sessionStart({ ...base, context_id: "ctx-noise" });
    for (let i = 0; i < 45; i++) {
      await store.remember(`noise ${i}: name`, {
        kind: "fact",
        certainty: "high",
      });
    }

    await store.sessionStart({ ...base, context_id: "ctx-target" });
    await store.remember("target context: name is Amit", {
      kind: "fact",
      certainty: "medium",
    });

    const result = await store.recall("name", { limit: 10 });

    expect(result.entries.map((e) => e.content)).toContain(
      "target context: name is Amit",
    );
    expect(result.entries.every((e) => e.content.startsWith("target context"))).toBe(
      true,
    );

    store.close();
  });

  it("ranks fuller FTS matches above partial matches with higher confidence", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new ThrowingEmbedder(),
    });

    await store.sessionStart({
      agent: "aria-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx-a",
      context_label: "test",
    });

    await store.remember("checkout uses a legacy job", {
      kind: "fact",
      certainty: "high",
    });
    await store.remember("checkout schema migration requires a rollback plan", {
      kind: "fact",
      certainty: "medium",
    });

    const result = await store.recall("checkout schema migration", { limit: 2 });

    expect(result.entries[0]?.content).toBe(
      "checkout schema migration requires a rollback plan",
    );

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
      layer: 1,
      confirmation_count: 0,
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
      layer: 1,
      confirmation_count: 0,
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
