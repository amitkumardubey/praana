import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryStore } from "../src/memory/index.js";
import { createMemoryTools, mirrorToCognitiveMemory } from "../src/tools/memory.js";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import type { EventLog } from "../src/event-log.js";
import type { StateGraph } from "../src/state-graph.js";

function mockEventLog(): EventLog {
  return {
    append: vi.fn(),
    search: vi.fn().mockReturnValue([]),
    readLast: vi.fn().mockReturnValue([]),
    close: vi.fn(),
    eventCount: vi.fn().mockReturnValue(0),
  } as unknown as EventLog;
}

function mockStateGraph(): StateGraph {
  let counter = 0;
  return {
    create: vi.fn((kind: string, payload: Record<string, unknown>) => {
      counter++;
      return {
        id: `state-${counter}`,
        kind,
        tier: "active",
        payload,
        created: Date.now(),
        updated: Date.now(),
        lastTouched: Date.now(),
      };
    }),
  } as unknown as StateGraph;
}

describe("state tool cognitive memory mirroring", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore({
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
  });

  it("mirrorToCognitiveMemory persists a constraint for recall", async () => {
    const mirror = await mirrorToCognitiveMemory(
      { memoryStore: store, memoryEnabled: true, incognito: false },
      "Never force-push main",
      "constraint",
    );

    expect(mirror?.memoryId).toBeTruthy();

    const recalled = await store.recall("force-push main", {
      kinds: ["constraint"],
      minMatch: 0,
    });
    expect(recalled.entries.some((e) => e.content.includes("Never force-push main"))).toBe(true);
  });

  it("add_constraint tool dual-writes to state graph and memory store", async () => {
    const tools = createMemoryTools({
      eventLog: mockEventLog(),
      stateGraph: mockStateGraph(),
      memoryStore: store,
      memoryEnabled: true,
      incognito: false,
    });

    const result = await tools.add_constraint.execute({
      text: "Use pnpm, not npm",
    });

    expect(result).toMatchObject({ ok: true, id: expect.any(String), memoryId: expect.any(String) });

    const recalled = await store.recall("pnpm npm", {
      kinds: ["constraint"],
      minMatch: 0,
    });
    expect(recalled.entries.some((e) => e.content.includes("Use pnpm, not npm"))).toBe(true);
  });
});
