// ========================================================================
// Shared BM25 Implementation for PRAANA
// ========================================================================
//
// Core tokenization and BM25 scoring utilities used by both the skills
// engine and the context engine.
//
// Tokenization keeps alphanumeric sequences including dots, slashes, and
// hyphens — better suited for code identifiers and file paths. The
// `tokenizeShort` variant additionally drops 1-char tokens (used by the
// skills engine to filter noise words like "a" or "i").

// BM25 parameters — Okapi BM25 standard defaults, not tunable externally.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

export interface BM25Stats {
  avgDocLen: number;
  totalDocs: number;
  docFreq: Map<string, number>;
}

/**
 * Tokenize text for BM25 search.
 * Preserves alphanumeric sequences including dots, slashes, hyphens
 * (good for file paths, component names, hyphenated terms).
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [];
}

/**
 * Tokenize with short-token filter (≤1 char tokens dropped).
 * Used by the skills engine to exclude single-char noise words like
 * "a" or "i" that inflate corpus statistics without contributing signal.
 */
export function tokenizeShort(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 1);
}

/**
 * Build BM25 corpus statistics from raw document strings.
 * Tokenizes each document with `tokenize()`.
 * Use `buildBM25StatsFromTokens` when the caller has already tokenized.
 */
export function buildBM25Stats(documents: string[]): BM25Stats {
  return buildBM25StatsFromTokens(documents.map(tokenize));
}

/**
 * Build BM25 corpus statistics from pre-tokenized documents.
 * Use this when the caller already has token arrays so tokenization
 * is not duplicated and the same token stream is used for both
 * stats and per-document scoring.
 */
export function buildBM25StatsFromTokens(tokenLists: string[][]): BM25Stats {
  const docFreq = new Map<string, number>();
  let totalLen = 0;

  for (const tokens of tokenLists) {
    totalLen += tokens.length;
    const seen = new Set(tokens);
    for (const t of seen) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }

  const totalDocs = tokenLists.length;
  const avgDocLen = totalDocs > 0 ? totalLen / totalDocs : 0;
  return { avgDocLen, totalDocs, docFreq };
}

/** BM25 scoring for a single document given pre-built corpus stats. */
export function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  stats: BM25Stats,
): number {
  const docLen = docTokens.length;
  if (docLen === 0 || queryTokens.length === 0) return 0;

  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const qt of queryTokens) {
    const freq = tf.get(qt) ?? 0;
    if (freq === 0) continue;

    const df = stats.docFreq.get(qt) ?? 1;
    const idf = Math.log(1 + (stats.totalDocs - df + 0.5) / (df + 0.5));
    const numerator = freq * (BM25_K1 + 1);
    const denominator = freq + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / stats.avgDocLen));
    score += idf * (numerator / denominator);
  }

  return score;
}

/**
 * Single-document BM25 relevance (context engine convenience wrapper).
 * Builds single-document stats inline so the API stays ergonomic for
 * one-off relevance checks.
 */
export function bm25Relevance(query: string, content: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenize(content);
  if (docTokens.length === 0) return 0;
  const stats = buildBM25StatsFromTokens([docTokens]);
  return bm25Score(queryTokens, docTokens, stats);
}
