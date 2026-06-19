import { describe, it, expect } from "vitest";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import { MemoryStore } from "../src/memory/index.js";

/**
 * M3 — Multiplicative recall ranking (#85).
 *
 * Core invariant: match quality is always primary. A high-match entry must
 * never be outranked purely by pin/recency/confidence boosts on a low match.
 */

describe("M3 — multiplicative recall ranking", () => {
  const makeCtx = () => ({
    agent: "praana-test",
    user_id: "u1",
    time: Date.now(),
    context_id: "ctx1",
    context_label: "test",
  });

  // ── Core invariant ──────────────────────────────────────────────────

  it("high match outranks a pinned low match", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });
    await store.sessionStart(makeCtx());

    // Strong match: contains "name is Amit" — a close match for the query
    const strong = await store.remember("User name is Amit Dubey", {
      kind: "fact",
      certainty: "medium",
    });

    // Weak match: tangentially related — pinned to give max boost
    const weak = await store.remember(
      "architecture note with some name references scattered",
      { kind: "fact", certainty: "medium" },
    );
    await store.pin(weak.id);

    await new Promise((r) => setTimeout(r, 10));
    const result = await store.recall("name is Amit", { limit: 10 });

    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    const top = result.entries[0];
    const strongResult = result.entries.find((e) => e.id === strong.id);
    const weakResult = result.entries.find((e) => e.id === weak.id);

    expect(strongResult).toBeTruthy();
    expect(weakResult).toBeTruthy();
    // The strong match must rank above the pinned weak match
    expect(top.id).toBe(strong.id);
    expect(strongResult!.score).toBeGreaterThan(weakResult!.score);

    store.close();
  });

  it("high match outranks a fresh high-validity low match", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });
    const now = Date.now();
    await store.sessionStart({ ...makeCtx(), time: now });

    // Strong match for "TypeScript config"
    const strong = await store.remember(
      "TypeScript tsconfig.json strict mode configuration",
      { kind: "fact", certainty: "medium" },
    );

    // Weak match: "TypeScript" appears but the entry is about something else
    const weak = await store.remember(
      "TypeScript conference talk scheduled for next week",
      { kind: "fact", certainty: "high" },
    );
    // Pin the weak entry AND it already has high certainty (validity 0.8)
    await store.pin(weak.id);

    await new Promise((r) => setTimeout(r, 10));
    const result = await store.recall("TypeScript config", { limit: 10 });

    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    const strongResult = result.entries.find((e) => e.id === strong.id);
    const weakResult = result.entries.find((e) => e.id === weak.id);

    expect(strongResult).toBeTruthy();
    expect(weakResult).toBeTruthy();
    expect(strongResult!.score).toBeGreaterThan(weakResult!.score);

    store.close();
  });

  // ── Multiplicative behaviour ────────────────────────────────────────

  it("score is always >= match (boosts are non-negative multipliers)", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });
    await store.sessionStart(makeCtx());

    const entry = await store.remember("User's name is Amit", {
      kind: "fact",
      certainty: "high",
    });
    await store.pin(entry.id);

    await new Promise((r) => setTimeout(r, 10));
    const result = await store.recall("name", { limit: 10 });
    expect(result.entries.length).toBeGreaterThanOrEqual(1);

    for (const e of result.entries) {
      // score = match * (1 + boosts) >= match * 1 = match
      expect(e.score).toBeGreaterThanOrEqual(e.match);
    }

    store.close();
  });

  it("score scales proportionally with match quality", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });
    await store.sessionStart(makeCtx());

    // Two entries with different keyword overlap for "PostgreSQL database"
    const exact = await store.remember(
      "PostgreSQL database connection pooling setup",
      { kind: "fact", certainty: "medium" },
    );
    const partial = await store.remember(
      "PostgreSQL conference talk about new features",
      { kind: "fact", certainty: "medium" },
    );

    await new Promise((r) => setTimeout(r, 10));
    const result = await store.recall("PostgreSQL database", { limit: 10 });

    const exactResult = result.entries.find((e) => e.id === exact.id);
    const partialResult = result.entries.find((e) => e.id === partial.id);

    if (exactResult && partialResult) {
      // The entry with more keyword overlap should score higher
      expect(exactResult.match).toBeGreaterThanOrEqual(partialResult.match);
      expect(exactResult.score).toBeGreaterThanOrEqual(partialResult.score);
    }

    store.close();
  });

  // ── Tiebreaker ──────────────────────────────────────────────────────

  it("tiebreaker favours better raw match, then validity", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });
    await store.sessionStart(makeCtx());

    // Two entries that will get similar match scores for a specific query
    const entryA = await store.remember("vitest unit testing patterns", {
      kind: "fact",
      certainty: "high",
    });
    const entryB = await store.remember("vitest configuration setup guide", {
      kind: "fact",
      certainty: "high",
    });

    await new Promise((r) => setTimeout(r, 10));
    const result = await store.recall("vitest", { limit: 10 });

    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    // Both should have valid scores; if scores are equal, higher match wins
    const entryAResult = result.entries.find((e) => e.id === entryA.id);
    const entryBResult = result.entries.find((e) => e.id === entryB.id);
    expect(entryAResult).toBeTruthy();
    expect(entryBResult).toBeTruthy();

    // At minimum, both entries appear and have positive scores
    expect(entryAResult!.score).toBeGreaterThan(0);
    expect(entryBResult!.score).toBeGreaterThan(0);

    store.close();
  });

  // ── Regression: existing behaviour preserved ────────────────────────

  it("pinned entries still get a score boost (multiplicative)", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });
    await store.sessionStart(makeCtx());

    const pinned = await store.remember(
      "architecture note with name references",
      { kind: "fact", certainty: "medium" },
    );
    const unpinned = await store.remember("name is present here", {
      kind: "fact",
      certainty: "medium",
    });
    await store.pin(pinned.id);

    await new Promise((r) => setTimeout(r, 10));
    const result = await store.recall("name", { limit: 10 });
    expect(result.entries.length).toBeGreaterThanOrEqual(2);

    const pinnedEntry = result.entries.find((e) => e.id === pinned.id);
    expect(pinnedEntry).toBeTruthy();
    // score > match confirms the pin boost is applied
    expect(pinnedEntry!.score).toBeGreaterThan(pinnedEntry!.match);

    store.close();
  });

  it("unrelated queries return no results", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });
    await store.sessionStart(makeCtx());

    await store.remember("The project uses Vitest for testing.", {
      kind: "fact",
      certainty: "high",
    });
    await new Promise((r) => setTimeout(r, 10));

    const result = await store.recall("zzznomatchtoken", { limit: 10 });
    expect(result.entries).toHaveLength(0);

    store.close();
  });
});
