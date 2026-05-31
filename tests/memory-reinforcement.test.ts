import { describe, it, expect } from "vitest";
import { HashEmbedder } from "../src/memory/index.js";
import {
  flushReinforcements,
  getEntryById,
  openMemoryDb,
  reinforceEntry,
  stampReinforcement,
  weakenEntry,
  insertEntry,
} from "../src/memory/db.js";
import { MemoryStore } from "../src/memory/store.js";

describe("Memory confidence reinforcement", () => {
  it("reinforceEntry increases confidence toward 1.0", () => {
    const { db } = openMemoryDb(":memory:");
    const now = Date.now();
    insertEntry(db, {
      id: "e1",
      kind: "fact",
      content: "test fact",
      confidence: 0.5,
      pinned: false,
      created_at: now,
      last_seen_at: now,
      session_id: "s1",
      scopes: [],
    });

    reinforceEntry(db, "e1", 0.15);
    const entry = getEntryById(db, "e1");
    expect(entry!.confidence).toBeGreaterThan(0.5);
    expect(entry!.confidence).toBeLessThanOrEqual(1.0);
    db.close();
  });

  it("weakenEntry reduces confidence", () => {
    const { db } = openMemoryDb(":memory:");
    const now = Date.now();
    insertEntry(db, {
      id: "e1",
      kind: "fact",
      content: "test fact",
      confidence: 0.8,
      pinned: false,
      created_at: now,
      last_seen_at: now,
      session_id: "s1",
      scopes: [],
    });

    weakenEntry(db, "e1", 0.3);
    const entry = getEntryById(db, "e1");
    expect(entry!.confidence).toBeCloseTo(0.56, 2);
    db.close();
  });

  it("flushReinforcements applies batched stamps at session end", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new HashEmbedder(),
    });

    const ctx = {
      agent: "aria-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    };

    await store.sessionStart(ctx);
    const { id } = await store.remember("Always use Vitest", {
      kind: "preference",
      certainty: "medium",
    });
    await new Promise((r) => setTimeout(r, 10));

    await store.recall("Vitest");
    const beforeEnd = store.getAllEntries().find((e) => e.id === id)!;
    const confBeforeFlush = beforeEnd.confidence;

    await store.sessionEnd("clean");

    const after = store.getAllEntries().find((e) => e.id === id)!;
    expect(after.confidence).toBeGreaterThan(confBeforeFlush);
    store.close();
  });

  it("stampReinforcement deduplicates per entry per session", () => {
    const { db } = openMemoryDb(":memory:");
    stampReinforcement(db, "e1", "sess-a");
    stampReinforcement(db, "e1", "sess-a");
    const rows = db
      .prepare("SELECT COUNT(*) as c FROM pending_reinforcements WHERE session_id = ?")
      .get("sess-a") as { c: number };
    expect(rows.c).toBe(1);
    db.close();
  });

  it("reinforceFromSuccessfulToolOutcome boosts confidence immediately", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new HashEmbedder(),
    });

    await store.sessionStart({
      agent: "aria-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    });

    const { id } = await store.remember("Use streaming when available", {
      kind: "fact",
      certainty: "medium",
    });
    await new Promise((r) => setTimeout(r, 5));

    const before = store.getAllEntries().find((e) => e.id === id)!;
    store.reinforceFromSuccessfulToolOutcome([id], 0.2);
    const after = store.getAllEntries().find((e) => e.id === id)!;

    expect(after.confidence).toBeGreaterThan(before.confidence);
    store.close();
  });
});
