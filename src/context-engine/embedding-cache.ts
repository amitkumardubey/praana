import type { Embedder } from "../memory/types.js";

function cacheKey(text: string): string {
  return text.trim();
}

export class EmbeddingCache {
  private readonly maxSize: number;
  private readonly store = new Map<string, Float32Array>();

  constructor(maxSize = 500) {
    this.maxSize = Math.max(1, maxSize);
  }

  get(text: string): Float32Array | undefined {
    const key = cacheKey(text);
    const existing = this.store.get(key);
    if (!existing) return undefined;
    // LRU bump.
    this.store.delete(key);
    this.store.set(key, existing);
    return existing;
  }

  set(text: string, vec: Float32Array): void {
    const key = cacheKey(text);
    if (!key) return;
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxSize) {
      const first = this.store.keys().next().value;
      if (first) this.store.delete(first);
    }
    this.store.set(key, vec);
  }

  entries(): IterableIterator<[string, Float32Array]> {
    return this.store.entries();
  }
}

export async function precomputeVectors(
  texts: string[],
  embedder: Embedder,
  cache: EmbeddingCache,
): Promise<Map<string, Float32Array>> {
  const unique = [...new Set(texts.map((t) => t.trim()).filter((t) => t.length > 0))];
  const map = new Map<string, Float32Array>();

  for (const text of unique) {
    const cached = cache.get(text);
    if (cached) {
      map.set(text, cached);
      continue;
    }
    const vec = await embedder.embed(text);
    cache.set(text, vec);
    map.set(text, vec);
  }

  return map;
}
