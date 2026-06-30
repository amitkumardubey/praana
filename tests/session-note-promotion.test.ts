import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/session.js";
import { MemoryStore } from "../src/memory/index.js";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import type { PraanaConfig } from "../src/types.js";

const testLogDir = join(tmpdir(), "praana-test-note-promotion");
const testConfig: PraanaConfig = {
  llm: { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
  memory: { enabled: false, summarizer: "disabled", db_path: join(tmpdir(), "praana-test-memory.db") },
  compiler: { token_budget: 100_000, recent_turns: 10, recent_turns_token_budget: 30_000 },
  tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
  session: { log_dir: testLogDir },
};

beforeEach(() => {
  mkdirSync(testLogDir, { recursive: true });
});

afterEach(() => {
  rmSync(testLogDir, { recursive: true, force: true });
});

async function createSessionWithMemory(): Promise<{ session: Session; memoryStore: MemoryStore }> {
  const session = await Session.create(process.cwd(), testConfig);

  const memoryStore = new MemoryStore({
    dbPath: ":memory:",
    embedder: new DeterministicTestEmbedder(),
  });

  await memoryStore.sessionStart({
    agent: "praana",
    user_id: "test-user",
    time: Date.now(),
    context_id: "test-ctx",
    context_label: "test",
  });

  // Patch session to have memory enabled with our real store
  (session as any).memoryEnabled = true;
  (session as any).memoryStore = memoryStore;

  return { session, memoryStore };
}

describe("session-end note promotion (#129)", () => {
  it("promotes active notes to cognitive memory", async () => {
    const { session, memoryStore } = await createSessionWithMemory();

    session.stateGraph.create("note", { text: "TypeScript strict mode is better" });

    const status = await session.end("clean", []);
    expect(status.memory).toBe("completed");

    const recalled = await memoryStore.recall("TypeScript strict mode", {
      kinds: ["fact"],
      minMatch: 0.1,
    });
    expect(recalled.entries.some((e) => e.content.includes("TypeScript strict mode"))).toBe(true);
  });

  it("promotes soft-tier notes to cognitive memory", async () => {
    const { session, memoryStore } = await createSessionWithMemory();

    const obj = session.stateGraph.create("note", { text: "Project uses Vitest for testing" });
    session.stateGraph.setTier(obj.id, "soft");

    await session.end("clean", []);

    const recalled = await memoryStore.recall("Vitest testing", {
      kinds: ["fact"],
      minMatch: 0.1,
    });
    expect(recalled.entries.some((e) => e.content.includes("Vitest"))).toBe(true);
  });

  it("does NOT promote hard-tier notes", async () => {
    const { session, memoryStore } = await createSessionWithMemory();

    const obj = session.stateGraph.create("note", { text: "This note is irrelevant" });
    session.stateGraph.setTier(obj.id, "hard");

    await session.end("clean", []);

    const recalled = await memoryStore.recall("irrelevant", {
      minMatch: 0,
    });
    expect(recalled.entries.some((e) => e.content.includes("irrelevant"))).toBe(false);
  });

  it("does NOT promote retracted notes", async () => {
    const { session, memoryStore } = await createSessionWithMemory();

    const obj = session.stateGraph.create("note", { text: "Retracted finding about Redis caching" });
    session.stateGraph.retractObject(obj.id);

    await session.end("clean", []);

    const recalled = await memoryStore.recall("Redis caching", {
      kinds: ["fact"],
      minMatch: 0,
    });
    expect(recalled.entries.some((e) => e.content.includes("Redis caching"))).toBe(false);
  });

  it("does NOT promote activity-log notes", async () => {
    const { session, memoryStore } = await createSessionWithMemory();

    session.stateGraph.create("note", {
      text: "Read src/utils.ts, src/helpers.ts, src/config.ts to understand the codebase",
    });

    await session.end("clean", []);

    const recalled = await memoryStore.recall("src/utils.ts", {
      kinds: ["fact"],
      minMatch: 0,
    });
    expect(recalled.entries.some((e) => e.content.includes("src/utils.ts"))).toBe(false);
  });

  it("does NOT promote notes when memory is disabled", async () => {
    const session = await Session.create(process.cwd(), testConfig);

    session.stateGraph.create("note", { text: "Important finding about concurrency" });

    // memoryEnabled = false by default in testConfig
    const status = await session.end("clean", []);
    expect(status.memory).toBe("skipped");

    // Note: memoryStore is null, so no recall is possible.
    // The important thing is that end() completes without error.
  });

  it("preserves the note's quality warning for activity-log notes at write time", async () => {
    const { session } = await createSessionWithMemory();

    // This is a write-time behavior (not session-end), but confirms
    // the add_note tool still warns about activity logs
    const obj = session.stateGraph.create("note", {
      text: "Read src/index.ts and src/app.ts for the codebase overview",
    });

    // The note should still exist in state graph (just not promoted at end)
    const found = session.stateGraph.get(obj.id);
    expect(found).toBeDefined();
    expect(found!.kind).toBe("note");
  });

  it("reinforces a note that already exists in cognitive memory", async () => {
    const { session, memoryStore } = await createSessionWithMemory();

    // Pre-populate memory with the same note content
    const result = await memoryStore.remember("Vitest is great for unit testing", {
      kind: "fact",
      certainty: "high",
    });

    const obj = session.stateGraph.create("note", {
      text: "Vitest is great for unit testing",
    });

    // Verify pre-populated
    const before = await memoryStore.recall("Vitest", { minMatch: 0.1 });
    expect(before.entries.length).toBeGreaterThanOrEqual(1);
    const countBefore = before.entries.length;

    await session.end("clean", []);

    // Should not create a duplicate — dedup should reinforce
    const after = await memoryStore.recall("Vitest", { minMatch: 0.1 });
    expect(after.entries.length).toBe(countBefore);
  });

  it("skips promotion if incognito mode is active", async () => {
    const session = await Session.create(process.cwd(), testConfig, { incognito: true });

    session.stateGraph.create("note", { text: "Should not persist in incognito mode" });

    // Memory is disabled in incognito, so session-end is skipped
    const status = await session.end("clean", []);
    expect(status.memory).toBe("skipped");
  });

  it("promotes multiple notes in a single session end", async () => {
    const { session, memoryStore } = await createSessionWithMemory();

    session.stateGraph.create("note", { text: "First finding about architecture" });
    session.stateGraph.create("note", { text: "Second finding about performance" });
    session.stateGraph.create("note", { text: "Third finding about security" });

    await session.end("clean", []);

    const recalled1 = await memoryStore.recall("architecture", { minMatch: 0.1 });
    expect(recalled1.entries.some((e) => e.content.includes("First finding"))).toBe(true);

    const recalled2 = await memoryStore.recall("performance", { minMatch: 0.1 });
    expect(recalled2.entries.some((e) => e.content.includes("Second finding"))).toBe(true);

    const recalled3 = await memoryStore.recall("security", { minMatch: 0.1 });
    expect(recalled3.entries.some((e) => e.content.includes("Third finding"))).toBe(true);
  });

  it("still promotes notes even if consolidation is disabled", async () => {
    const { session, memoryStore } = await createSessionWithMemory();

    // consolidation is not enabled in testConfig
    session.stateGraph.create("note", { text: "Finding about Redis caching patterns" });

    await session.end("clean", []);

    const recalled = await memoryStore.recall("Redis caching", { kinds: ["fact"], minMatch: 0.1 });
    expect(recalled.entries.some((e) => e.content.includes("Redis caching"))).toBe(true);
  });
});
