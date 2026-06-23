// ========================================================================
// Shared BM25 Implementation for PRAANA
// ========================================================================

// Core tokenization and BM25 scoring utilities used by both skills engine and context engine

export interface BM25Config {
  k1?: number;
  b?: number;
}

export interface BM25Stats {
  avgDocLen: number;
  totalDocs: number;
  docFreq: Map<string, number>;
}

export const DEFAULT_BM25_CONFIG: BM25Config = {
  k1: 1.5,
  b: 0.75,
};

/** Tokenize text for BM25 search - shared between skills and context engines */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [];
}

/** Build BM25 statistics from a corpus of documents */
export function buildBM25Stats(documents: string[]): BM25Stats {
  const docFreq = new Map<string, number>();
  const docTokenLists: string[][] = [];

  for (const doc of documents) {
    const tokens = tokenize(doc);
    docTokenLists.push(tokens);
    const unique = new Set(tokens);
    for (const token of unique) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const totalDocs = documents.length;
  const avgDocLen = totalDocs > 0 
    ? docTokenLists.reduce((sum, tokens) => sum + tokens.length, 0) / totalDocs 
    : 0;

  return { avgDocLen, totalDocs, docFreq };
}

/** Calculate BM25 score for a single document against query tokens using stats */
export function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  config: BM25Config,
  stats: BM25Stats,
): number {
  const k1 = config.k1 ?? DEFAULT_BM25_CONFIG.k1!;
  const b = config.b ?? DEFAULT_BM25_CONFIG.b!;
  const docLen = docTokens.length;

  // Count term frequencies in this document
  const tf = new Map<string, number>();
  for (const token of docTokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

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

/** BM25 relevance for single document (for context engine compatibility) */
export function bm25Relevance(
  query: string,
  content: string,
  config?: BM25Config,
): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenize(content);
  if (docTokens.length === 0) return 0;
  
  // Create minimal stats for single document scoring
  const stats = buildBM25Stats([content]);
  return bm25Score(queryTokens, docTokens, config ?? {}, stats);
}

/** Synonym expansion for query tokens */
export function expandTokens(
  tokens: string[],
  synonymMap: Record<string, string[]>,
): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    const syns = synonymMap[token];
    if (syns) {
      for (const syn of syns) {
        expanded.add(syn);
      }
    }
  }
  return Array.from(expanded);
}

/** Default synonym map for V1 */
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

/** Keyword score bonus: fraction of unique doc tokens that match query */
export function calculateKeywordScore(queryTokens: string[], docTokens: string[]): number {
  const querySet = new Set(queryTokens);
  const docSet = new Set(docTokens);
  const overlap = [...querySet].filter((t) => docSet.has(t)).length;
  return docSet.size > 0 ? overlap / docSet.size : 0;
}

/** Name match bonus: if the skill name appears in the query */
export function calculateNameMatchBonus(queryTokens: string[], nameTokens: string[]): number {
  const querySet = new Set(queryTokens);
  return nameTokens.some((nt) => querySet.has(nt)) ? 0.25 : 0;
}

/** Exact skill invocation detection */
export function isExactInvocation(userInput: string, targetName: string): boolean {
  return userInput.trim().toLowerCase() === targetName.toLowerCase();
}