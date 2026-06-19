import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  openMemoryDb,
  insertEntry,
  upsertEmbedding,
  getStoredEmbeddingBackend,
} from "../src/memory/db.js";

describe("embedding backend migration", () => {
  it("marks re-embed needed when backend changes at same dimension", () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-backend-"));
    const dbPath = join(dir, "memory.db");

    try {
      const first = openMemoryDb(dbPath, 384, "hash");
      first.db.close();

      const second = openMemoryDb(dbPath, 384, "transformers:Xenova/all-MiniLM-L6-v2");
      expect(second.needsReembed).toBe(true);
      expect(getStoredEmbeddingBackend(second.db)).toBe(
        "transformers:Xenova/all-MiniLM-L6-v2",
      );
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mark re-embed when backend is unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-backend-"));
    const dbPath = join(dir, "memory.db");

    try {
      const first = openMemoryDb(dbPath, 384, "hash");
      first.db.close();

      const second = openMemoryDb(dbPath, 384, "hash");
      expect(second.needsReembed).toBe(false);
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
