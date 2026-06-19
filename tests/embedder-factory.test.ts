import { beforeAll, describe, it, expect } from "vitest";
import { createEmbedder } from "../src/memory/embedder-factory.js";
import {
  TransformersEmbedder,
  isTransformersAvailable,
} from "../src/memory/index.js";
import type { MemoryConfig } from "../src/types.js";
import type { Embedder } from "../src/memory/types.js";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";

const HAS_TRANSFORMERS = await isTransformersAvailable();
const TRANSFORMERS_TIMEOUT_MS = 120_000;

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
  it("returns null when auto and transformers is unavailable", async () => {
    if (HAS_TRANSFORMERS) return;

    const embedder = await createEmbedder(makeConfig({ embedder: "auto" }));
    expect(embedder).toBeNull();
  });

  it(
    "returns TransformersEmbedder when auto and transformers is available",
    async () => {
      if (!HAS_TRANSFORMERS) return;

      const embedder = await createEmbedder(makeConfig({ embedder: "auto" }));
      expect(embedder).toBeInstanceOf(TransformersEmbedder);
      expect(embedder!.dim).toBe(384);
    },
    TRANSFORMERS_TIMEOUT_MS,
  );

  it(
    "does not use Ollama under auto even if reachable",
    async () => {
      if (!HAS_TRANSFORMERS) return;

      const embedder = await createEmbedder(
        makeConfig({
          embedder: "auto",
          ollama_url: "http://localhost:11434",
        }),
      );
      expect(embedder).toBeInstanceOf(TransformersEmbedder);
    },
    TRANSFORMERS_TIMEOUT_MS,
  );

  it("returns null when 'ollama' strategy and daemon is unreachable", async () => {
    const embedder = await createEmbedder(
      makeConfig({
        embedder: "ollama",
        ollama_url: "http://127.0.0.1:19999",
      }),
    );
    expect(embedder).toBeNull();
  });

  it("returns null when 'transformers' backend is not installed", async () => {
    if (HAS_TRANSFORMERS) return;

    const embedder = await createEmbedder(makeConfig({ embedder: "transformers" }));
    expect(embedder).toBeNull();
  });

  it("DeterministicTestEmbedder produces fixed-length Float32Array", async () => {
    const embedder = new DeterministicTestEmbedder();
    const vec = await embedder.embed("hello world");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(embedder.dim);
  });

  it("DeterministicTestEmbedder produces unit-norm vectors", async () => {
    const embedder = new DeterministicTestEmbedder();
    const vec = await embedder.embed("unit norm check");
    let norm = 0;
    for (const v of vec) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 5);
  });

  it("DeterministicTestEmbedder is deterministic for the same input", async () => {
    const embedder = new DeterministicTestEmbedder();
    const a = await embedder.embed("same text");
    const b = await embedder.embed("same text");
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe.skipIf(!HAS_TRANSFORMERS)("TransformersEmbedder", () => {
  let embedder: Embedder;

  beforeAll(async () => {
    embedder = await createEmbedder(makeConfig({ embedder: "transformers" }));
  }, TRANSFORMERS_TIMEOUT_MS);

  it("produces unit-norm vectors", async () => {
    const vec = await embedder.embed("unit norm check");
    let norm = 0;
    for (const v of vec) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 3);
  });

  it("is deterministic for the same input", async () => {
    const a = await embedder.embed("same text");
    const b = await embedder.embed("same text");
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
