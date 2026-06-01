import { describe, it, expect } from "vitest";
import { MemoryStore, HashEmbedder } from "../src/memory/index.js";
import type { SummarizerLLM } from "../src/memory/types.js";
import { heuristicContradiction } from "../src/memory/dedup.js";

describe("sessionEnd duplicate and contradiction detection", () => {
  const ctx = {
    agent: "aria",
    user_id: "u1",
    time: Date.now(),
    context_id: "ctx1",
    context_label: "test",
  };

  it("reinforces existing entry instead of storing duplicate", async () => {
    const summarizer: SummarizerLLM = {
      name: "test",
      available: async () => true,
      complete: async () =>
        JSON.stringify([
          {
            kind: "fact",
            content: "Project uses Vitest for testing",
            certainty: "high",
          },
        ]),
    };

    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new HashEmbedder(),
      summarizer,
    });

    await store.sessionStart(ctx);
    await store.remember("Project uses Vitest for testing", {
      kind: "fact",
      certainty: "high",
    });
    const before = store.getAllEntries()[0].confidence;
    await store.sessionEnd("clean", [
      { type: "user_message", timestamp: Date.now(), content: "tests" },
    ]);

    expect(store.getAllEntries()).toHaveLength(1);
    expect(store.getAllEntries()[0].confidence).toBeGreaterThan(before);
  });

  it("weakens contradictory entry before storing new learning", async () => {
    expect(
      heuristicContradiction(
        "Streaming is implemented in turn.ts",
        "Streaming is not implemented in turn.ts",
      ),
    ).toBe(true);

    const summarizer: SummarizerLLM = {
      name: "test",
      available: async () => true,
      complete: async () =>
        JSON.stringify([
          {
            kind: "fact",
            content: "Streaming is not implemented in turn.ts",
            certainty: "high",
          },
        ]),
    };

    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new HashEmbedder(),
      summarizer,
    });

    await store.sessionStart(ctx);
    await store.remember("Streaming is implemented in turn.ts", {
      kind: "fact",
      certainty: "high",
    });
    const beforeConf = store.getAllEntries()[0].confidence;
    await store.sessionEnd("clean", [
      { type: "user_message", timestamp: Date.now(), content: "streaming" },
    ]);

    const entries = store.getAllEntries();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const weakened = entries.find(
      (e) => e.content.includes("implemented in turn.ts") && !e.content.includes("not"),
    );
    expect(weakened?.confidence).toBeLessThan(beforeConf);
  });
});
