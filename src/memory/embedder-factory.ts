// ============================================================
// ARIA Memory — Embedder factory (auto / ollama / opt-in backends)
// ============================================================

import type { MemoryConfig } from "../types.js";
import { getAppLogger } from "../logger.js";
import { envOverride } from "../app-identity.js";
import { HashEmbedder, OllamaEmbedder } from "./embeddings.js";
import type { Embedder } from "./types.js";

export async function createEmbedder(config: MemoryConfig): Promise<Embedder> {
  const log = getAppLogger().child("memory");
  const strategy = config.embedder ?? "auto";
  const ollamaUrl = config.ollama_url ?? "http://localhost:11434";

  if (strategy === "auto" || strategy === "ollama") {
    const model = config.ollama_model ?? "nomic-embed-text";
    if (await OllamaEmbedder.isAvailable(ollamaUrl, model)) {
      log.notice(`embedder: ${model}`);
      return new OllamaEmbedder(ollamaUrl, model);
    }
    if (strategy === "ollama") {
      log.warn(
        `Ollama not available or model '${model}' not loaded — falling back to hash embedder. Run: ollama pull ${model}`,
      );
    }
  }

  if (strategy === "transformers") {
    const embedder = await tryTransformersEmbedder();
    if (embedder) return embedder;
    log.warn(
      "@huggingface/transformers not available — falling back to hash embedder. Install with: npm install @huggingface/transformers",
    );
  }

  if (strategy === "llama-cpp") {
    const embedder = await tryLlamaCppEmbedder();
    if (embedder) return embedder;
    log.warn(
      "node-llama-cpp not available — falling back to hash embedder. Install with: npm install node-llama-cpp",
    );
  }

  if (strategy === "auto") {
    log.warn(
      "Ollama unavailable — using hash embedder (non-semantic recall). Run `ollama pull nomic-embed-text` for semantic embeddings.",
    );
  } else if (strategy !== "hash") {
    log.warn(
      'Semantic recall unavailable — using hash embedder (non-semantic recall). Set embedder = "transformers" in config for local semantic embeddings (no daemon required).',
    );
  }

  return new HashEmbedder();
}

async function tryTransformersEmbedder(): Promise<Embedder | null> {
  try {
    const spec = "@huggingface/transformers";
    const { pipeline } = await import(/* webpackIgnore: true */ spec);
    const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    return {
      dim: 384,
      async embed(text: string): Promise<Float32Array> {
        const out = await pipe(text, { pooling: "mean", normalize: true });
        return out.data as Float32Array;
      },
    };
  } catch {
    return null;
  }
}

async function tryLlamaCppEmbedder(): Promise<Embedder | null> {
  try {
    const spec = "node-llama-cpp";
    const { getLlama, LlamaEmbeddingContext } = await import(/* webpackIgnore: true */ spec);
    const llama = await getLlama();
    const modelPath =
      envOverride("PRAANA_EMBED_MODEL_PATH", "ARIA_EMBED_MODEL_PATH") ??
      "models/nomic-embed-text-v1.5.Q8_0.gguf";
    const model = await llama.loadModel({ modelPath });
    const ctx = await LlamaEmbeddingContext.create({ model });
    // Probe actual output dimension rather than assuming 384.
    const probe = await ctx.getEmbeddingFor("probe");
    const dim = probe.vector.length;
    return {
      dim,
      async embed(text: string): Promise<Float32Array> {
        const { vector } = await ctx.getEmbeddingFor(text);
        return vector;
      },
    };
  } catch {
    return null;
  }
}
