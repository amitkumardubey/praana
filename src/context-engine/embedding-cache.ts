import type { Embedder } from "../memory/types.js";

const DEFAULT_EMBED_CONCURRENCY = 4;

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

async function embedTextsConcurrently(
  texts: string[],
  embedder: Embedder,
  cache: EmbeddingCache,
  concurrency = DEFAULT_EMBED_CONCURRENCY,
): Promise<void> {
  if (texts.length === 0) return;

  let next = 0;
  const workerCount = Math.min(concurrency, texts.length);

  async function worker(): Promise<void> {
    while (next < texts.length) {
      const index = next++;
      const text = texts[index];
      const vec = await embedder.embed(text);
      cache.set(text, vec);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

export async function precomputeVectors(
  texts: string[],
  embedder: Embedder,
  cache: EmbeddingCache,
): Promise<Map<string, Float32Array>> {
  const unique = [...new Set(texts.map((t) => t.trim()).filter((t) => t.length > 0))];
  const map = new Map<string, Float32Array>();
  const toEmbed: string[] = [];

  for (const text of unique) {
    const cached = cache.get(text);
    if (cached) {
      map.set(text, cached);
    } else {
      toEmbed.push(text);
    }
  }

  await embedTextsConcurrently(toEmbed, embedder, cache);

  for (const text of toEmbed) {
    const vec = cache.get(text);
    if (vec) map.set(text, vec);
  }

  return map;
}
