import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "bun:test";
import { openMemoryDb, insertEntry, upsertEmbedding } from "../src/memory/db.js";
import { MemoryStore } from "../src/memory/store.js";
import type { Embedder } from "../src/memory/types.js";

class FixedEmbedder implements Embedder {
  constructor(readonly dim: number) {}

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dim);
    vec[0] = text.length || 1;
    return vec;
  }
}

async function withTempDb<T>(fn: (dbPath: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "praana-memory-"));
  const dbPath = join(dir, "memory.db");
  try {
    return await fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedEntry(dbPath: string): void {
  const { db } = openMemoryDb(dbPath, 2);
  const now = Date.now();
  insertEntry(db, {
    id: "entry-1",
    kind: "fact",
    content: "dimension migration must recover",
    validity: 0.8,
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
  upsertEmbedding(db, "entry-1", new Float32Array([1, 0]));
  db.close();
}

describe("Memory vector re-embedding migration", () => {
  it("retries re-embedding on the next open if the prior migration did not finish", () =>
    withTempDb((dbPath) => {
      seedEntry(dbPath);

      const firstMigration = openMemoryDb(dbPath, 3);
      expect(firstMigration.needsReembed).toBe(true);
      firstMigration.db.close();

      const retry = openMemoryDb(dbPath, 3);
      expect(retry.needsReembed).toBe(true);
      retry.db.close();
    }));

  it("sessionStart waits for pending re-embedding and clears the retry flag", () =>
    withTempDb(async (dbPath) => {
      seedEntry(dbPath);

      const store = new MemoryStore({
        dbPath,
        embedder: new FixedEmbedder(3),
      });

      await store.sessionStart({
        agent: "praana-test",
        user_id: "u1",
        time: Date.now(),
        context_id: "ctx1",
        context_label: "test",
      });
      store.close();

      const reopened = openMemoryDb(dbPath, 3);
      expect(reopened.needsReembed).toBe(false);
      const rows = reopened.db
        .prepare("SELECT COUNT(*) as c FROM entries_vec")
        .get() as { c: number };
      expect(rows.c).toBe(1);
      reopened.db.close();
    }));
});
