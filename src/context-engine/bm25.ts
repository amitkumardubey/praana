export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [];
}

export function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  avgDocLen: number,
  totalDocs: number,
  docFreq: Map<string, number>,
): number {
  const k1 = 1.5;
  const b = 0.75;
  const docLen = docTokens.length;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const qt of queryTokens) {
    const freq = tf.get(qt) ?? 0;
    if (freq === 0) continue;
    const df = docFreq.get(qt) ?? 1;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const numerator = freq * (k1 + 1);
    const denominator = freq + k1 * (1 - b + b * (docLen / avgDocLen));
    score += idf * (numerator / denominator);
  }
  return score;
}

export function bm25Relevance(query: string, content: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenize(content);
  if (docTokens.length === 0) return 0;
  return bm25Score(queryTokens, docTokens, docTokens.length, 1, new Map());
}
