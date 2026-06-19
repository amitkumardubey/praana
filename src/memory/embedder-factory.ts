// ============================================================
// PRAANA Memory — Embedder factory
// ============================================================

import type { MemoryConfig } from "../types.js";
import { getAppLogger } from "../logger.js";
import { envOverride } from "../app-identity.js";
import { HashEmbedder, OllamaEmbedder } from "./embeddings.js";
import { TransformersEmbedder } from "./transformers-embedder.js";
import type { Embedder } from "./types.js";

function isTransformersStrategy(strategy: string): boolean {
  return strategy === "transformers" || strategy === "transformers-nomic" || strategy === "auto";
}

async function tryTransformersEmbedder(
  config: MemoryConfig,
): Promise<TransformersEmbedder | null> {
  const strategy = config.embedder ?? "auto";
  return TransformersEmbedder.create({
    strategy,
    model: config.transformers_model,
  });
}

export function resolveEmbeddingBackend(
  config: MemoryConfig,
  embedder: Embedder,
): string {
  if (embedder instanceof HashEmbedder) return "hash";
  if (embedder instanceof OllamaEmbedder) return "ollama";
  if (embedder instanceof TransformersEmbedder) return `transformers:${embedder.modelId}`;
  return config.embedder ?? "unknown";
}

export async function createEmbedder(config: MemoryConfig): Promise<Embedder> {
  const log = getAppLogger().child("memory");
  const strategy = config.embedder ?? "auto";
  const ollamaUrl = config.ollama_url ?? "http://localhost:11434";

  if (strategy === "hash") {
    return new HashEmbedder();
  }

  if (isTransformersStrategy(strategy)) {
    const embedder = await tryTransformersEmbedder(config);
    if (embedder) {
      log.notice(`embedder: transformers (${embedder.modelId}, ${embedder.dim}-dim)`);
      return embedder;
    }

    log.warn(
      '@huggingface/transformers unavailable — using hash embedder (non-semantic recall). Install with: npm install @huggingface/transformers',
    );
    return new HashEmbedder();
  }

  if (strategy === "ollama") {
    const model = config.ollama_model ?? "nomic-embed-text";
    if (await OllamaEmbedder.isAvailable(ollamaUrl, model)) {
      log.notice(`embedder: ollama (${model})`);
      return new OllamaEmbedder(ollamaUrl, model);
    }
    log.warn(
      `Ollama not available or model '${model}' not loaded — falling back to hash embedder. Run: ollama pull ${model}`,
    );
    return new HashEmbedder();
  }

  if (strategy === "llama-cpp") {
    const embedder = await tryLlamaCppEmbedder();
    if (embedder) return embedder;
    log.warn(
      "node-llama-cpp not available — falling back to hash embedder. Install with: npm install node-llama-cpp",
    );
    return new HashEmbedder();
  }

  log.warn(`Unknown embedder strategy '${strategy}' — using hash embedder`);
  return new HashEmbedder();
}

async function tryLlamaCppEmbedder(): Promise<Embedder | null> {
  try {
    const spec = "node-llama-cpp";
    const { getLlama, LlamaEmbeddingContext } = await import(/* webpackIgnore: true */ spec);
    const llama = await getLlama();
    const modelPath =
      envOverride("PRAANA_EMBED_MODEL_PATH") ??
      "models/nomic-embed-text-v1.5.Q8_0.gguf";
    const model = await llama.loadModel({ modelPath });
    const ctx = await LlamaEmbeddingContext.create({ model });
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
