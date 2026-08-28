import type { Embedder } from "../../src/memory/types.js";
import { EMBEDDING_DIM } from "../../src/memory/embeddings.js";

/**
 * Deterministic test-only embedder for tests that need vector operations.
 *
 * Hashed bag-of-tokens (not a full-string seed in the positive orthant). A
 * whole-string hash made unrelated queries still pass cosine `minMatch`
 * because every unit vector lived in [0,1)^n.
 */
export class DeterministicTestEmbedder implements Embedder {
  readonly dim = EMBEDDING_DIM;

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dim);
    const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    const features = tokens.length > 0 ? tokens : ["\0"];
    for (const token of features) {
      let h = 2166136261;
      for (let i = 0; i < token.length; i++) {
        h ^= token.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
      }
      const idx = Math.abs(h) % this.dim;
      vec[idx]! += (h & 1) === 0 ? 1 : -1;
    }
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) vec[i]! /= norm;
    }
    return vec;
  }
}
