import { describe, it, expect } from "bun:test";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import { MemoryStore } from "../src/memory/index.js";
import { effectiveValidity, HALF_LIFE_DAYS } from "../src/memory/confidence.js";
import type { MemoryEntry } from "../src/memory/types.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now();
  return {
    id: "test-id",
    kind: "fact",
    content: "test",
    validity: 0.8,
    usefulness: 0.5,
    pinned: false,
    layer: 1,
    confirmation_count: 0,
    created_at: now,
    last_seen_at: now,
    session_id: "s1",
    scopes: [],
    retracted: false,
    ...overrides,
  };
}

describe("memory layer schema and half-life decay", () => {
  it("defaults new entries to layer 1 with confirmation_count 0", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });

    await store.sessionStart({
      agent: "praana",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    });

    await store.remember("Uses Vitest for tests", { kind: "fact", certainty: "high" });
    const entries = store.getAllEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].layer).toBe(1);
    expect(entries[0].confirmation_count).toBe(0);
    expect(entries[0].retracted).toBe(false);
  });

  it("constraints never decay", () => {
    const now = Date.now();
    const entry = makeEntry({
      kind: "constraint",
      created_at: now - 365 * 86_400_000,
    });
    expect(effectiveValidity(entry, now)).toBe(0.8);
    expect(HALF_LIFE_DAYS.constraint).toBeNull();
  });

  it("layer 2 entries decay 4× slower than layer 1", () => {
    const now = Date.now();
    const ageDays = 90;
    const created = now - ageDays * 86_400_000;

    const layer1 = makeEntry({ layer: 1, kind: "fact", created_at: created });
    const layer2 = makeEntry({ layer: 2, kind: "fact", created_at: created });

    const conf1 = effectiveValidity(layer1, now);
    const conf2 = effectiveValidity(layer2, now);
    expect(conf2).toBeGreaterThan(conf1);
  });

  it("digest renders layer 2 entries before layer 1", async () => {
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
    await store.remember("Layer one fact", { kind: "fact", certainty: "high" });
    await store.sessionEnd("clean");

    const entries = store.getAllEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    store["db"]
      .prepare("UPDATE entries SET layer = 2, content = ? WHERE id = ?")
      .run("Layer two consolidated fact", entry.id);
    store["db"]
      .prepare("UPDATE entries_fts SET content = ? WHERE entry_id = ?")
      .run("Layer two consolidated fact", entry.id);

    const digest = await store.sessionStart(ctx);
    expect(digest.markdown).toContain("Layer two consolidated fact");
  });
});
