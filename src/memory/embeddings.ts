// ============================================================
// PRAANA Memory — Embeddings
// ============================================================

import type { Embedder } from "./types.js";

export const EMBEDDING_DIM = 384;

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
