// ============================================================
// ARIA Memory — Embeddings
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
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    const seed = Math.abs(h);
    for (let i = 0; i < this.dim; i++) {
      const x = Math.sin(seed * (i + 1) * 12.9898) * 43758.5453;
      vec[i] = x - Math.floor(x);
    }
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < this.dim; i++) vec[i] /= norm;
    return vec;
  }
}

/** Ollama nomic-embed-text — 768-dim semantic embeddings via local daemon. */
export class OllamaEmbedder implements Embedder {
  readonly dim = 768;

  constructor(
    private url = "http://localhost:11434",
    private model = "nomic-embed-text",
  ) {}

  static async isAvailable(url: string, model?: string): Promise<boolean> {
    try {
      const res = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      if (!model) return true;
      const data = (await res.json()) as { models: { name: string }[] };
      return data.models.some(
        (m) => m.name === model || m.name.startsWith(`${model}:`),
      );
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(`${this.url}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
    const { embedding } = (await res.json()) as { embedding: number[] };
    return new Float32Array(embedding);
  }
}
