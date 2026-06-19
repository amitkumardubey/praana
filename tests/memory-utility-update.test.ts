import { describe, it, expect } from "vitest";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import {
  flushReinforcements,
  getEntryById,
  insertEntry,
  openMemoryDb,
  stampReinforcement,
  markReinforcementUsed,
} from "../src/memory/db.js";
import { MemoryStore } from "../src/memory/store.js";

describe("M2 utility update loop", () => {
  it("used ∧ good → usefulness boosted", () => {
    const { db } = openMemoryDb(":memory:");
    const now = Date.now();
    const sessionId = "sess-good";

    insertEntry(db, {
      id: "e1",
      kind: "fact",
      content: "test fact",
      validity: 0.8,
      usefulness: 0.5,
      pinned: false,
      layer: 1,
      confirmation_count: 0,
      created_at: now,
      last_seen_at: now,
      session_id: sessionId,
      scopes: [],
      retracted: false,
    });

    stampReinforcement(db, "e1", sessionId);
    markReinforcementUsed(db, "e1", sessionId, true);
    db.prepare("UPDATE pending_reinforcements SET good = 1 WHERE session_id = ?").run(sessionId);

    flushReinforcements(db, sessionId);

    const entry = getEntryById(db, "e1")!;
    // α_use = 0.15, start 0.5 → 0.5 + (1-0.5)*0.15 = 0.575
    expect(entry.usefulness).toBeCloseTo(0.575, 3);
    db.close();
  });

  it("used ∧ ¬good → usefulness unchanged (neutral)", () => {
    const { db } = openMemoryDb(":memory:");
    const now = Date.now();
    const sessionId = "sess-bad";

    insertEntry(db, {
      id: "e1",
      kind: "fact",
      content: "test fact",
      validity: 0.8,
      usefulness: 0.5,
      pinned: false,
      layer: 1,
      confirmation_count: 0,
      created_at: now,
      last_seen_at: now,
      session_id: sessionId,
      scopes: [],
      retracted: false,
    });

    stampReinforcement(db, "e1", sessionId);
    markReinforcementUsed(db, "e1", sessionId, true);
    // good stays 0 (bad session)

    flushReinforcements(db, sessionId);

    const entry = getEntryById(db, "e1")!;
    // Neutral: usefulness stays at 0.5
    expect(entry.usefulness).toBeCloseTo(0.5, 3);
    db.close();
  });

  it("¬used → usefulness decays", () => {
    const { db } = openMemoryDb(":memory:");
    const now = Date.now();
    const sessionId = "sess-idle";

    insertEntry(db, {
      id: "e1",
      kind: "fact",
      content: "test fact",
      validity: 0.8,
      usefulness: 0.5,
      pinned: false,
      layer: 1,
      confirmation_count: 0,
      created_at: now,
      last_seen_at: now,
      session_id: sessionId,
      scopes: [],
      retracted: false,
    });

    stampReinforcement(db, "e1", sessionId);
    // used stays 0 (not used)

    flushReinforcements(db, sessionId);

    const entry = getEntryById(db, "e1")!;
    // β_idle = 0.05, start 0.5 → 0.5 * 0.95 = 0.475
    expect(entry.usefulness).toBeCloseTo(0.475, 3);
    db.close();
  });

  it("not surfaced → usefulness untouched", () => {
    const { db } = openMemoryDb(":memory:");
    const now = Date.now();
    const sessionId = "sess-other";

    insertEntry(db, {
      id: "e1",
      kind: "fact",
      content: "test fact",
      validity: 0.8,
      usefulness: 0.5,
      pinned: false,
      layer: 1,
      confirmation_count: 0,
      created_at: now,
      last_seen_at: now,
      session_id: sessionId,
      scopes: [],
      retracted: false,
    });

    // Don't stamp — entry was never surfaced in this session

    flushReinforcements(db, sessionId);

    const entry = getEntryById(db, "e1")!;
    // Not surfaced: usefulness stays at 0.5
    expect(entry.usefulness).toBeCloseTo(0.5, 3);
    db.close();
  });

  it("validity is still reinforced alongside utility update", () => {
    const { db } = openMemoryDb(":memory:");
    const now = Date.now();
    const sessionId = "sess-both";

    insertEntry(db, {
      id: "e1",
      kind: "fact",
      content: "test fact",
      validity: 0.5,
      usefulness: 0.5,
      pinned: false,
      layer: 1,
      confirmation_count: 0,
      created_at: now,
      last_seen_at: now,
      session_id: sessionId,
      scopes: [],
      retracted: false,
    });

    stampReinforcement(db, "e1", sessionId);
    markReinforcementUsed(db, "e1", sessionId, true);
    db.prepare("UPDATE pending_reinforcements SET good = 1 WHERE session_id = ?").run(sessionId);

    flushReinforcements(db, sessionId);

    const entry = getEntryById(db, "e1")!;
    // validity: 0.5 + (1-0.5)*0.15 = 0.575
    expect(entry.validity).toBeCloseTo(0.575, 3);
    // usefulness: 0.5 + (1-0.5)*0.15 = 0.575
    expect(entry.usefulness).toBeCloseTo(0.575, 3);
    db.close();
  });

  it("end-to-end: sessionEnd updates usefulness for used entries", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });

    const ctx = {
      agent: "praana-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    };

    // Start session, create a memory, recall it
    await store.sessionStart(ctx);
    const { id } = await store.remember("Always use Vitest for testing", {
      kind: "preference",
      certainty: "high",
    });
    await new Promise((r) => setTimeout(r, 10));

    // Recall stamps the entry as surfaced
    await store.recall("Vitest");

    // End session with "normal" reason and at least one successful tool result.
    // Co-occurrence fallback: entry "Always use Vitest for testing" terms
    // must match tool-call args/results. Use a shell tool with Vitest in output.
    await store.sessionEnd("normal", [
      {
        type: "tool_result",
        timestamp: Date.now(),
        tool_name: "shell",
        result: { ok: true, output: "using Vitest for testing setup" },
      },
    ]);

    // The entry should have boosted usefulness > 0.5 due to co-occurrence:
    // "Vitest" and "testing" both appear in the tool result
    const entry = store.getAllEntries().find((e) => e.id === id)!;
    expect(entry.usefulness).toBeGreaterThan(0.5);
    store.close();
  });

  it("not surfaced — usefulness untouched", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });

    const ctx = {
      agent: "praana-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    };

    await store.sessionStart(ctx);
    const { id } = await store.remember("Always use Vitest for testing", {
      kind: "preference",
      certainty: "high",
    });
    await new Promise((r) => setTimeout(r, 10));

    // No recall — entry is NOT in pending_reinforcements
    // End session
    await store.sessionEnd("normal", [
      { type: "user_message", timestamp: Date.now(), content: "run tests" },
    ]);

    // Entry was not surfaced, so usefulness stays at 0.5
    const entry = store.getAllEntries().find((e) => e.id === id)!;
    expect(entry.usefulness).toBeCloseTo(0.5, 3);
    store.close();
  });
});
