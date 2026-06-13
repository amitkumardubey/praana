import { describe, it, expect } from "vitest";
import { MemoryStore, HashEmbedder } from "../src/memory/index.js";

describe("Recall ranking", () => {
  it("sorts by match score and keeps confidence separate", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new HashEmbedder(),
    });

    const ctx = {
      agent: "praana-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    };

    await store.sessionStart(ctx);
    await store.remember("User's name is Amit", {
      kind: "fact",
      certainty: "medium",
    }); // conf 0.5
    await store.remember("Thinking block rendering issue with tool calls", {
      kind: "fact",
      certainty: "high",
    }); // conf 0.8

    await new Promise((r) => setTimeout(r, 10));

    const result = await store.recall("name", { limit: 10 });
    expect(result.entries.length).toBeGreaterThanOrEqual(2);

    const top = result.entries[0];
    const nameEntry = result.entries.find((e) => e.content.includes("name is Amit"));
    const other = result.entries.find((e) => e.content.includes("Thinking block"));

    expect(nameEntry).toBeTruthy();
    expect(nameEntry!.match).toBeGreaterThan(0);
    expect(other).toBeTruthy();
    expect(other!.confidence).toBeGreaterThan(nameEntry!.confidence);
    expect(top.score).toBeGreaterThanOrEqual(result.entries[result.entries.length - 1].score);

    store.close();
  });

  it("preserves pin priority in recall order", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new HashEmbedder(),
    });

    const ctx = {
      agent: "praana-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    };

    await store.sessionStart(ctx);
    const pinned = await store.remember("Unrelated architecture note", {
      kind: "fact",
      certainty: "medium",
    });
    await store.remember("name is present here", {
      kind: "fact",
      certainty: "medium",
    });
    await store.pin(pinned.id);

    await new Promise((r) => setTimeout(r, 10));

    const result = await store.recall("zzznomatchtoken", { limit: 10 });
    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    const pinnedEntry = result.entries.find((e) => e.id === pinned.id);
    expect(pinnedEntry).toBeTruthy();
    expect(pinnedEntry!.score).toBeGreaterThan(pinnedEntry!.match);

    store.close();
  });
});
