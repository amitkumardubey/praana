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

export interface BM25Config {
  k1?: number;
  b?: number;
}

export interface BM25Stats {
  avgDocLen: number;
  totalDocs: number;
  docFreq: Map<string, number>;
}

export const DEFAULT_BM25_CONFIG: Required<BM25Config> = {
  k1: 1.5,
  b: 0.75,
};

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
 * Matches the legacy skills-engine behavior where single-char noise
 * words like "a", "i" are excluded from the token stream.
 */
export function tokenizeShort(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 1);
}

/** Build BM25 corpus statistics from raw document strings. */
export function buildBM25Stats(documents: string[]): BM25Stats {
  const docFreq = new Map<string, number>();
  let totalLen = 0;

  for (const doc of documents) {
    const tokens = tokenize(doc);
    totalLen += tokens.length;
    const seen = new Set(tokens);
    for (const t of seen) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }

  const totalDocs = documents.length;
  const avgDocLen = totalDocs > 0 ? totalLen / totalDocs : 0;
  return { avgDocLen, totalDocs, docFreq };
}

/** BM25 scoring for a single document given pre-built corpus stats. */
export function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  stats: BM25Stats,
): number {
  const { k1, b } = DEFAULT_BM25_CONFIG;
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
    const numerator = freq * (k1 + 1);
    const denominator = freq + k1 * (1 - b + b * (docLen / stats.avgDocLen));
    score += idf * (numerator / denominator);
  }

  return score;
}

/**
 * Single-document BM25 relevance (context engine wrapper).
 * Builds single-document stats inline so the API stays ergonomic.
 */
export function bm25Relevance(query: string, content: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenize(content);
  if (docTokens.length === 0) return 0;
  const stats = buildBM25Stats([content]);
  return bm25Score(queryTokens, docTokens, stats);
}

/** Synonym expansion for query tokens. */
export function expandTokens(
  tokens: string[],
  synonymMap: Record<string, string[]>,
): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    const syns = synonymMap[token];
    if (syns) for (const syn of syns) expanded.add(syn);
  }
  return Array.from(expanded);
}

/** Default synonym map for V1. */
export const DEFAULT_SYNONYMS: Record<string, string[]> = {
  deploy: ["launch", "release", "rollout", "publish"],
  database: ["db", "postgres", "mysql", "sql", "rds", "dynamodb"],
  container: ["docker", "ecs", "kubernetes", "k8s", "pod"],
  aws: ["amazon", "ec2", "s3", "lambda", "cloud"],
  test: ["testing", "spec", "assert", "verify", "check"],
  build: ["compile", "bundle", "package", "construct"],
  error: ["error", "failure", "bug", "issue", "crash", "exception"],
  fix: ["fix", "repair", "patch", "resolve", "correct"],
  code: ["code", "source", "implementation", "program"],
  review: ["review", "audit", "inspect", "check"],
  config: ["configuration", "setup", "settings", "options"],
  monitor: ["monitoring", "observe", "watch", "track", "metrics"],
  auth: ["authentication", "login", "oauth", "sso", "identity"],
  api: ["rest", "graphql", "endpoint", "service", "http"],
};
