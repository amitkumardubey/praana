import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../src/memory/store.js";
import type { MemoryStore as MemoryStoreType } from "../src/memory/store.js";
import { ulid } from "ulid";
import { openMemoryDb } from "../src/memory/db.js";
import { APP_AGENT_ID } from "../src/app-identity.js";

// In-memory SQLite for fast isolated tests. Each test gets a fresh store.
async function newStore(): Promise<MemoryStoreType> {
  const store = new MemoryStore({
    dbPath: ":memory:",
    embedder: null,
    summarizer: null,
  });
  await store.sessionStart({
    agent: APP_AGENT_ID,
    user_id: "test-user",
    context_id: "test-context",
    time: Date.now(),
    context_label: "test",
  });
  return store;
}

// Helper: access the underlying better-sqlite3 db for direct assertion/seed.
function dbOf(store: MemoryStoreType): import("better-sqlite3").Database {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}

const tracked: MemoryStoreType[] = [];

describe("M4 promotion gate — distinct sessions", () => {
  afterEach(() => {
    while (tracked.length) {
      const s = tracked.pop();
      try {
        s?.close();
      } catch {
        /* ignore */
      }
    }
  });

  it("promotes an entry confirmed in 2 distinct sessions with validity >= 0.7", async () => {
    const store = await newStore();
    tracked.push(store);

    const { id } = await store.remember("Project uses Vitest", {
      kind: "fact",
      certainty: "high", // → validity 0.8
    });

    // Simulate two distinct past sessions confirming the entry by writing
    // confirmation rows directly. This is the production-shaped input the gate
    // consumes; sessionEnd also writes such rows via the surfaced-entry path.
    const db = dbOf(store);
    db.prepare(
      "INSERT OR IGNORE INTO confirmations (entry_id, session_id, ts) VALUES (?, ?, ?)",
    ).run(id, "session_B", Date.now());
    db.prepare(
      "INSERT OR IGNORE INTO confirmations (entry_id, session_id, ts) VALUES (?, ?, ?)",
    ).run(id, "session_C", Date.now());

    await store.sessionEnd("normal", []);

    const entry = store.getAllEntries().find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.layer).toBe(2);
  });

  it("does NOT promote when only 1 distinct session confirms (even 5× repeats)", async () => {
    const store = await newStore();
    tracked.push(store);

    const { id } = await store.remember("Project uses Vitest", {
      kind: "fact",
      certainty: "high",
    });

    const db = dbOf(store);
    // 5 repeats in the SAME session — INSERT OR IGNORE collapses to one row.
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT OR IGNORE INTO confirmations (entry_id, session_id, ts) VALUES (?, ?, ?)",
      ).run(id, "only_session", Date.now());
    }

    await store.sessionEnd("normal", []);

    const entry = store.getAllEntries().find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.layer).toBe(1); // stays at layer 1
  });

  it("does NOT promote when distinct sessions >= 2 but validity is below 0.7", async () => {
    const store = await newStore();
    tracked.push(store);

    const { id } = await store.remember("Maybe uses Jest", {
      kind: "fact",
      certainty: "low", // → validity 0.3
    });

    const db = dbOf(store);
    db.prepare(
      "INSERT OR IGNORE INTO confirmations (entry_id, session_id, ts) VALUES (?, ?, ?)",
    ).run(id, "session_B", Date.now());
    db.prepare(
      "INSERT OR IGNORE INTO confirmations (entry_id, session_id, ts) VALUES (?, ?, ?)",
    ).run(id, "session_C", Date.now());

    await store.sessionEnd("normal", []);

    const entry = store.getAllEntries().find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.layer).toBe(1);
  });

  it("does NOT promote a retracted entry even if confirmed by many sessions", async () => {
    const store = await newStore();
    tracked.push(store);

    const { id } = await store.remember("Old fact", {
      kind: "fact",
      certainty: "high",
    });
    const db = dbOf(store);
    for (const s of ["s1", "s2", "s3"]) {
      db.prepare(
        "INSERT OR IGNORE INTO confirmations (entry_id, session_id, ts) VALUES (?, ?, ?)",
      ).run(id, s, Date.now());
    }
    store.retractMemory(id);

    await store.sessionEnd("normal", []);

    const entry = store.getAllEntries().find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.layer).toBe(1);
  });

  it("promotes multiple entries in one pass when they all meet the gate", async () => {
    const store = await newStore();
    tracked.push(store);

    const a = await store.remember("Fact A", { kind: "fact", certainty: "high" });
    const b = await store.remember("Fact B", { kind: "fact", certainty: "high" });
    const c = await store.remember("Fact C low", { kind: "fact", certainty: "low" });

    const db = dbOf(store);
    for (const eid of [a.id, b.id]) {
      db.prepare(
        "INSERT OR IGNORE INTO confirmations (entry_id, session_id, ts) VALUES (?, ?, ?)",
      ).run(eid, "sess_x", Date.now());
      db.prepare(
        "INSERT OR IGNORE INTO confirmations (entry_id, session_id, ts) VALUES (?, ?, ?)",
      ).run(eid, "sess_y", Date.now());
    }
    // C gets 2 confirms but low validity
    for (const s of ["sess_x", "sess_y"]) {
      db.prepare(
        "INSERT OR IGNORE INTO confirmations (entry_id, session_id, ts) VALUES (?, ?, ?)",
      ).run(c.id, s, Date.now());
    }

    await store.sessionEnd("normal", []);

    const entries = store.getAllEntries();
    expect(entries.find((e) => e.id === a.id)!.layer).toBe(2);
    expect(entries.find((e) => e.id === b.id)!.layer).toBe(2);
    expect(entries.find((e) => e.id === c.id)!.layer).toBe(1);
  });

  it("applyPromotionGate returns the promoted ids for logging/observability", async () => {
    const store = await newStore();
    tracked.push(store);

    const { id } = await store.remember("Observable promote", {
      kind: "fact",
      certainty: "high",
    });
    const db = dbOf(store);
    db.prepare(
      "INSERT OR IGNORE INTO confirmations (entry_id, session_id, ts) VALUES (?, ?, ?)",
    ).run(id, "s1", Date.now());
    db.prepare(
      "INSERT OR IGNORE INTO confirmations (entry_id, session_id, ts) VALUES (?, ?, ?)",
    ).run(id, "s2", Date.now());

    const promoted = store.applyPromotionGate();
    expect(promoted).toContain(id);
    // Second call: entry is already layer 2, gate must not double-fire.
    const promoted2 = store.applyPromotionGate();
    expect(promoted2).not.toContain(id);
  });
});

describe("M4 promotion gate — confirmations recorded via sessionEnd", () => {
  afterEach(() => {
    while (tracked.length) {
      const s = tracked.pop();
      try {
        s?.close();
      } catch {
        /* ignore */
      }
    }
  });

  it("records a confirmation row for every entry surfaced this session", async () => {
    const store = await newStore();
    tracked.push(store);

    const { id } = await store.remember("Surfaceable fact", {
      kind: "fact",
      certainty: "high",
    });
    // Force the entry to be recalled + surfaced by doing a recall.
    await store.recall("Surfaceable", { limit: 5, minMatch: 0 });

    const sessionId = (store as unknown as { sessionId: string }).sessionId;
    const db = dbOf(store);
    const before = db
      .prepare("SELECT COUNT(*) AS c FROM confirmations WHERE entry_id = ?")
      .get(id) as { c: number };
    expect(before.c).toBe(0);

    await store.sessionEnd("normal", []);

    const after = db
      .prepare("SELECT COUNT(*) AS c FROM confirmations WHERE entry_id = ?")
      .get(id) as { c: number };
    expect(after.c).toBe(1);
    const row = db
      .prepare(
        "SELECT session_id FROM confirmations WHERE entry_id = ? AND session_id = ?",
      )
      .get(id, sessionId);
    expect(row).toBeDefined();
  });
});

describe("M4 promotion gate — confirmations helpers", () => {
  it("recordConfirmation is idempotent per (entry_id, session_id)", async () => {
    const opened = openMemoryDb(":memory:", 384);
    const db = opened.db;
    const id = ulid();
    db.prepare(
      "INSERT INTO entries (id, kind, content, validity, usefulness, pinned, layer, confirmation_count, created_at, last_seen_at, session_id) VALUES (?, 'fact', 'x', 0.8, 0.5, 0, 1, 0, ?, ?, 'sA')",
    ).run(id, Date.now(), Date.now());

    const { recordConfirmation, countDistinctConfirmingSessions } = await import(
      "../src/memory/db.js"
    );

    for (let i = 0; i < 10; i++) {
      recordConfirmation(db, id, "sA", Date.now());
    }
    expect(countDistinctConfirmingSessions(db, id)).toBe(1);

    recordConfirmation(db, id, "sB", Date.now());
    recordConfirmation(db, id, "sC", Date.now());
    expect(countDistinctConfirmingSessions(db, id)).toBe(3);

    db.close();
  });
});

describe("M4 promotion gate — digest surfacing counts as confirmation", () => {
  afterEach(() => {
    while (tracked.length) {
      const s = tracked.pop();
      try {
        s?.close();
      } catch {
        /* ignore */
      }
    }
  });

  it("promotes an entry surfaced only via the session-start digest across 2 distinct sessions (no explicit recall())", async () => {
    const store = await newStore();
    tracked.push(store);

    // Created in session A — not yet in A's digest (built before remember).
    const { id } = await store.remember("Project uses Vitest for tests", {
      kind: "fact",
      certainty: "high", // validity 0.8 → surfaces in digest, clears 0.7 gate
    });
    await store.sessionEnd("normal", []);

    const db = dbOf(store);
    const afterA = db
      .prepare("SELECT COUNT(*) AS c FROM confirmations WHERE entry_id = ?")
      .get(id) as { c: number };
    // Not surfaced in session A (entry didn't exist when A's digest was built).
    expect(afterA.c).toBe(0);

    // Session B: the entry now appears in the start-of-session digest and is
    // stamped as surfaced — WITHOUT any explicit recall() tool call.
    await store.sessionStart({
      agent: APP_AGENT_ID,
      user_id: "test-user",
      context_id: "test-context",
      time: Date.now(),
      context_label: "test",
    });
    await store.sessionEnd("normal", []);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS c FROM confirmations WHERE entry_id = ?")
          .get(id) as { c: number }
      ).c,
    ).toBe(1);
    // Still Layer 1 after one distinct confirming session.
    expect(store.getAllEntries().find((e) => e.id === id)!.layer).toBe(1);

    // Session C: second distinct surfacing → distinct count hits 2 → promote.
    await store.sessionStart({
      agent: APP_AGENT_ID,
      user_id: "test-user",
      context_id: "test-context",
      time: Date.now(),
      context_label: "test",
    });
    await store.sessionEnd("normal", []);

    const entry = store.getAllEntries().find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.layer).toBe(2);
  });

  it("diagnostic getDigest() does NOT stamp surfaced/confirmation rows", async () => {
    const store = await newStore();
    tracked.push(store);

    const { id } = await store.remember("Build runs on Node 22", {
      kind: "fact",
      certainty: "high",
    });

    // getDigest is a display/refresh path — must not record confirmations.
    await store.getDigest(0.35);

    const db = dbOf(store);
    const surfaced = db
      .prepare("SELECT COUNT(*) AS c FROM pending_reinforcements WHERE entry_id = ?")
      .get(id) as { c: number };
    expect(surfaced.c).toBe(0);
  });
});
