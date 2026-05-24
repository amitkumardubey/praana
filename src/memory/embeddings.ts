// ============================================================
// ARIA Memory — Embeddings
//
// For MVP: deterministic hash-based vectors (StubEmbeddingsProvider).
// Upgrade path: swap in OpenAI/Ollama/local embedder.
// ============================================================

import type { Embedder } from "./types.js";

export const EMBEDDING_DIM = 384;

// Deterministic hash-based embedding — fast, offline, zero dependencies.
// Different text → different vector. Same text → same vector.
// NOT semantic — just a cheap approximate nearest neighbor.
export class HashEmbedder implements Embedder {
  readonly dim = EMBEDDING_DIM;

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dim);
    // Simple hash-based embedding: distribute text hash across dimensions
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    const seed = Math.abs(h);
    // Seeded pseudo-random fill
    for (let i = 0; i < this.dim; i++) {
      const x = Math.sin(seed * (i + 1) * 12.9898) * 43758.5453;
      vec[i] = x - Math.floor(x); // [0,1)
    }
    // Normalize to unit sphere
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < this.dim; i++) vec[i] /= norm;
    return vec;
  }
}

// Upgrade: OpenAI text-embedding-3-small (1536 dims)
// export class OpenAIEmbedder implements Embedder { ... }

// Upgrade: Ollama nomic-embed-text (768 dims)
// export class OllamaEmbedder implements Embedder { ... }
