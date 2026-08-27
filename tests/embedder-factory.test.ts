import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as downloadConsentActual from "../src/ui/tui/download-consent.js";
import { createEmbedder } from "../src/memory/embedder-factory.js";
import {
  TransformersEmbedder,
  isTransformersAvailable,
  isModelCached,
  resetTransformersEmbedderForTests,
} from "../src/memory/index.js";
import type { MemoryConfig } from "../src/types.js";
import type { Embedder } from "../src/memory/types.js";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";

const HAS_TRANSFORMERS = await isTransformersAvailable();
const TRANSFORMERS_TIMEOUT_MS = 120_000;

const downloadConsentReal = { ...downloadConsentActual };

// Mutable flag: when true, the mocked confirmModelDownload returns false
// (decline), simulating a user who cancels the download prompt.
let declineDownload = false;

// Mock download-consent so tests never attempt to render a TUI overlay.
// The real function guards on process.stderr.isTTY, but mocking ensures
// no ProcessTerminal is ever constructed in the test process.
mock.module("../src/ui/tui/download-consent.js", () => ({
  ...downloadConsentActual,
  confirmModelDownload: async (_modelId: string) => !declineDownload,
}));

afterAll(() => {
  mock.module("../src/ui/tui/download-consent.js", () => downloadConsentReal);
});

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

describe("isModelCached", () => {
  it("returns true when the onnx directory exists", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "praana-cache-"));
    const modelId = "Xenova/all-MiniLM-L6-v2";
    mkdirSync(join(tmpDir, modelId, "onnx"), { recursive: true });
    expect(isModelCached(tmpDir, modelId)).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when the onnx directory does not exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "praana-cache-"));
    expect(isModelCached(tmpDir, "Xenova/nonexistent-model")).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false for an empty cache directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "praana-cache-"));
    expect(isModelCached(tmpDir, "Xenova/all-MiniLM-L6-v2")).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe.skipIf(!HAS_TRANSFORMERS)("download consent", () => {
  it(
    "returns null when user declines the download",
    async () => {
      // Point PRAANA_HOME to a temp dir so the model is not cached there,
      // forcing loadPipeline to call confirmModelDownload. The mock returns
      // false (decline) → loadPipeline throws → create() catches → null.
      resetTransformersEmbedderForTests();
      const tmpHome = mkdtempSync(join(tmpdir(), "praana-home-"));
      const prevHome = process.env.PRAANA_HOME;
      process.env.PRAANA_HOME = tmpHome;
      declineDownload = true;

      try {
        const embedder = await createEmbedder(makeConfig({ embedder: "transformers" }));
        expect(embedder).toBeNull();
      } finally {
        declineDownload = false;
        if (prevHome === undefined) delete process.env.PRAANA_HOME;
        else process.env.PRAANA_HOME = prevHome;
        resetTransformersEmbedderForTests();
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    TRANSFORMERS_TIMEOUT_MS,
  );
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
