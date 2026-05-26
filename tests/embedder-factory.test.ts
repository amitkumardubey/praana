import { describe, it, expect } from "vitest";
import { createEmbedder } from "../src/memory/embedder-factory.js";
import { HashEmbedder } from "../src/memory/index.js";
import type { MemoryConfig } from "../src/types.js";

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    enabled: true,
    summarizer: "disabled",
    embedder: "auto",
    ollama_url: "http://localhost:11434",
    ollama_model: "nomic-embed-text",
    ...overrides,
  };
}

describe("createEmbedder factory", () => {
  it("returns HashEmbedder when embedder is 'hash'", async () => {
    const embedder = await createEmbedder(makeConfig({ embedder: "hash" }));
    expect(embedder).toBeInstanceOf(HashEmbedder);
  });

  it("returns HashEmbedder when auto and Ollama is unreachable", async () => {
    const embedder = await createEmbedder(
      makeConfig({
        embedder: "auto",
        ollama_url: "http://127.0.0.1:19999", // nothing listening here
      }),
    );
    expect(embedder).toBeInstanceOf(HashEmbedder);
  });

  it("returns HashEmbedder when 'ollama' strategy and daemon is unreachable", async () => {
    const embedder = await createEmbedder(
      makeConfig({
        embedder: "ollama",
        ollama_url: "http://127.0.0.1:19999",
      }),
    );
    expect(embedder).toBeInstanceOf(HashEmbedder);
  });

  it("returns HashEmbedder when 'transformers' backend is not installed", async () => {
    // @huggingface/transformers is not in devDependencies — should fall back
    const embedder = await createEmbedder(makeConfig({ embedder: "transformers" }));
    expect(embedder).toBeInstanceOf(HashEmbedder);
  });

  it("HashEmbedder produces fixed-length Float32Array", async () => {
    const embedder = await createEmbedder(makeConfig({ embedder: "hash" }));
    const vec = await embedder.embed("hello world");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(embedder.dim);
  });

  it("HashEmbedder produces unit-norm vectors", async () => {
    const embedder = await createEmbedder(makeConfig({ embedder: "hash" }));
    const vec = await embedder.embed("unit norm check");
    let norm = 0;
    for (const v of vec) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 5);
  });

  it("HashEmbedder is deterministic for the same input", async () => {
    const embedder = await createEmbedder(makeConfig({ embedder: "hash" }));
    const a = await embedder.embed("same text");
    const b = await embedder.embed("same text");
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
