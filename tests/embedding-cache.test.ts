import { describe, it, expect } from "bun:test";
import { EmbeddingCache, precomputeVectors } from "../src/context-engine/embedding-cache.js";
import type { Embedder } from "../src/memory/types.js";

describe("EmbeddingCache", () => {
  it("evicts oldest entry when max size is exceeded", () => {
    const cache = new EmbeddingCache(2);
    cache.set("a", new Float32Array([1]));
    cache.set("b", new Float32Array([2]));
    cache.set("c", new Float32Array([3]));

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("bumps LRU order on get", () => {
    const cache = new EmbeddingCache(2);
    cache.set("a", new Float32Array([1]));
    cache.set("b", new Float32Array([2]));
    cache.get("a");
    cache.set("c", new Float32Array([3]));

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });
});

describe("precomputeVectors", () => {
  it("deduplicates texts and reuses session cache", async () => {
    let calls = 0;
    const embedder: Embedder = {
      dim: 2,
      embed: async (text: string) => {
        calls += 1;
        return text.includes("one") ? new Float32Array([1, 0]) : new Float32Array([0, 1]);
      },
    };
    const cache = new EmbeddingCache();

    const first = await precomputeVectors([" one ", "one", "two"], embedder, cache);
    const second = await precomputeVectors(["one", "two"], embedder, cache);

    expect(first.size).toBe(2);
    expect(second.size).toBe(2);
    expect(calls).toBe(2);
  });

  it("yields between synchronous embeddings while preserving vectors and cache hits", async () => {
    const events: string[] = [];
    const embedder: Embedder = {
      dim: 2,
      embed: async (text) => {
        events.push(text);
        if (text === "a") setImmediate(() => events.push("immediate"));
        return new Float32Array([text.charCodeAt(0), 1]);
      },
    };
    const cache = new EmbeddingCache();
    const vectors = await precomputeVectors(["a", "b", "c"], embedder, cache);
    expect(events).toContain("immediate");
    expect(events.indexOf("immediate")).toBeLessThan(events.indexOf("b"));
    expect([...vectors.entries()]).toEqual([
      ["a", new Float32Array([97, 1])],
      ["b", new Float32Array([98, 1])],
      ["c", new Float32Array([99, 1])],
    ]);
    const cached = await precomputeVectors(["a", "b", "c"], embedder, cache);
    expect([...cached.entries()]).toEqual([...vectors.entries()]);
    expect(events.filter((event) => event !== "immediate")).toEqual(["a", "b", "c"]);
  });

  it("falls back gracefully when embedder throws", async () => {
    const embedder: Embedder = {
      dim: 2,
      embed: async () => {
        throw new Error("embed failed");
      },
    };
    const cache = new EmbeddingCache();

    await expect(precomputeVectors(["alpha"], embedder, cache)).rejects.toThrow("embed failed");
  });
});
