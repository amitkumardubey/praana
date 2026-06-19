import { mkdtempSync, rmSync } from "node:fs";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  openMemoryDb,
  insertEntry,
  markReembedNeeded,
  upsertEmbedding,
} from "../src/memory/db.js";
import { MemoryStore } from "../src/memory/store.js";
import type { Embedder } from "../src/memory/types.js";

class FailingEmbedder implements Embedder {
  readonly dim = 384;

  async embed(): Promise<Float32Array> {
    throw new Error("embed failed");
  }
}

describe("recall after embedder migration", () => {
  it("returns a migration notice instead of unrelated entries when re-embed failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-recall-"));
    const dbPath = join(dir, "memory.db");

    try {
      const { db } = openMemoryDb(dbPath, 384, "hash");
      const now = Date.now();
      insertEntry(db, {
        id: "entry-1",
        kind: "fact",
        content: "The project uses Vitest for testing.",
        validity: 0.9,
        usefulness: 0.5,
        pinned: false,
        layer: 1,
        confirmation_count: 0,
        created_at: now,
        last_seen_at: now,
        session_id: "session-1",
        scopes: ["user:u1", "agent:praana-test", "context:ctx1"],
        retracted: false,
      });
      markReembedNeeded(db);
      db.close();

      const store = new MemoryStore({
        dbPath,
        embedder: new FailingEmbedder(),
        embeddingBackend: "transformers:Xenova/nomic-embed-text-v1",
      });

      await store.sessionStart({
        agent: "praana-test",
        user_id: "u1",
        time: Date.now(),
        context_id: "ctx1",
        context_label: "test",
      });

      const result = await store.recall("amit", { limit: 20 });

      expect(result.entries).toHaveLength(0);
      expect(result.notice).toMatch(/migration incomplete/i);

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not dump scoped entries with match 0.00 when search finds nothing", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });

    await store.sessionStart({
      agent: "praana-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    });

    await store.remember("The project uses Vitest for testing.", {
      kind: "fact",
      certainty: "high",
    });

    await new Promise((r) => setTimeout(r, 10));

    const result = await store.recall("amit", { limit: 20 });
    const vitestOnly = result.entries.filter((e) =>
      e.content.includes("Vitest"),
    );

    for (const entry of vitestOnly) {
      expect(entry.match).toBeGreaterThan(0);
    }

    store.close();
  });

  it("re-embeds entries after a dimension change before recall", async () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-recall-"));
    const dbPath = join(dir, "memory.db");

    try {
      const { db } = openMemoryDb(dbPath, 384, "hash");
      const now = Date.now();
      insertEntry(db, {
        id: "entry-1",
        kind: "fact",
        content: "User's name is Amit",
        validity: 0.9,
        usefulness: 0.5,
        pinned: false,
        layer: 1,
        confirmation_count: 0,
        created_at: now,
        last_seen_at: now,
        session_id: "session-1",
        scopes: ["user:u1", "agent:praana-test", "context:ctx1"],
        retracted: false,
      });
      upsertEmbedding(db, "entry-1", new Float32Array(384).fill(0.1));
      db.close();

      const store = new MemoryStore({
        dbPath,
        embedder: new DeterministicTestEmbedder(),
        embeddingBackend: "transformers:Xenova/all-MiniLM-L6-v2",
      });

      await store.sessionStart({
        agent: "praana-test",
        user_id: "u1",
        time: Date.now(),
        context_id: "ctx1",
        context_label: "test",
      });

      const result = await store.recall("Amit", { limit: 5 });
      expect(result.notice).toBeUndefined();
      expect(result.entries.some((e) => e.content.includes("Amit"))).toBe(true);
      expect(result.entries[0]?.match ?? 0).toBeGreaterThan(0);

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
