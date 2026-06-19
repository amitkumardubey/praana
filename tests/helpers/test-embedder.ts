import type { Embedder } from "../../src/memory/types.js";
import { EMBEDDING_DIM } from "../../src/memory/embeddings.js";

/** Deterministic test-only embedder for tests that need vector operations. */
export class DeterministicTestEmbedder implements Embedder {
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
