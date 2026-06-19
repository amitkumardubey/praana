// ============================================================
// PRAANA Memory — Embedder factory
// ============================================================

import type { MemoryConfig } from "../types.js";
import { getAppLogger } from "../logger.js";
import { OllamaEmbedder } from "./embeddings.js";
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
  embedder: Embedder | null,
): string {
  if (!embedder) return "keyword-only";
  if (embedder instanceof OllamaEmbedder) return "ollama";
  if (embedder instanceof TransformersEmbedder) return `transformers:${embedder.modelId}`;
  return config.embedder ?? "unknown";
}

export async function createEmbedder(config: MemoryConfig): Promise<Embedder | null> {
  const log = getAppLogger().child("memory");
  const strategy = config.embedder ?? "auto";
  const ollamaUrl = config.ollama_url ?? "http://localhost:11434";

  if (isTransformersStrategy(strategy)) {
    const embedder = await tryTransformersEmbedder(config);
    if (embedder) {
      log.notice(`embedder: transformers (${embedder.modelId}, ${embedder.dim}-dim)`);
      return embedder;
    }

    log.warn(
      'Transformers embedder failed to load — recall will use keyword search only.',
    );
    return null;
  }

  if (strategy === "ollama") {
    const model = config.ollama_model ?? "nomic-embed-text";
    if (await OllamaEmbedder.isAvailable(ollamaUrl, model)) {
      log.notice(`embedder: ollama (${model})`);
      return new OllamaEmbedder(ollamaUrl, model);
    }
    log.warn(
      `Ollama not available or model '${model}' not loaded — recall will use keyword search only. Run: ollama pull ${model}`,
    );
    return null;
  }

  log.warn(`Unknown embedder strategy '${strategy}' — recall will use keyword search only`);
  return null;
}
