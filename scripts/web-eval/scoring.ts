import { isBotWall, type FetchOutcome, type Outcome, type SearchOutcome } from "./runners/base.js";
import type { FetchTask, SearchTask } from "./tasks.js";

export interface SearchSample { runner: string; task: SearchTask; outcome: SearchOutcome }
export interface FetchSample { runner: string; task: FetchTask; outcome: FetchOutcome }
export interface Rate { hits: number; n: number; value: number | null; interval: [number, number] | null }

/** Two-sided 95% Wilson score interval. Empty cells are unknown, not 0%. */
export function rate(hits: number, n: number): Rate {
  if (!Number.isInteger(n) || !Number.isInteger(hits) || hits < 0 || hits > n) throw new Error("Invalid rate counts");
  if (!n) return { hits, n, value: null, interval: null };
  const z = 1.959963984540054, z2 = z * z, p = hits / n;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return { hits, n, value: p, interval: [Math.max(0, center - half), Math.min(1, center + half)] };
}
export function latencyStats(values: number[]) {
  const sorted = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const n = sorted.length;
  return { n, median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null, p90: n ? sorted[Math.ceil(n * 0.9) - 1] : null };
}
const contains = (text: string, probe: string) => text.toLocaleLowerCase("en-US").includes(probe.toLocaleLowerCase("en-US"));
const ratio = (total: number, n: number) => ({ n, value: n ? total / n : null });
function common(outcomes: Outcome[], skipped: number) {
  const n = outcomes.length;
  const known = outcomes.filter(o => o.credits !== undefined);
  return {
    n, skipped,
    latencyMs: latencyStats(outcomes.map(o => o.latencyMs)),
    totalTokens: outcomes.reduce((sum, o) => sum + o.tokens, 0),
    failureRate: rate(outcomes.filter(o => !o.ok).length, n),
    rateLimitRate: rate(outcomes.filter(o => o.error_kind === "rate_limited" || o.status === 429).length, n),
    credits: { reportedN: known.length, unknownN: n - known.length, total: known.length ? known.reduce((sum, o) => sum + o.credits!, 0) : null },
  };
}
function domainHit(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return domains.some(d => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
  } catch { return false; }
}

export function scoreSearch(samples: SearchSample[]) {
  const attempted = samples.filter(s => !s.outcome.skipped);
  const base = common(attempted.map(s => s.outcome), samples.length - attempted.length);
  let recall = 0, answerQueries = 0, precisionHits = 0, returned = 0, covered = 0, weak = 0, honest = 0;
  for (const { task, outcome } of attempted) {
    const results = outcome.results.slice(0, 5);
    const domain = results.some(r => domainHit(r.url, task.expected_domains));
    const answerHits = results.filter(r => task.answer_snippets.some(probe => contains(r.snippet, probe))).length;
    recall += Number(domain);
    answerQueries += Number(answerHits > 0);
    precisionHits += answerHits;
    returned += results.length;
    covered += Number(results.length > 0);
    if (!domain || !answerHits) {
      weak++;
      // An empty list itself communicates no evidence; no invented weak confidence.
      honest += Number(!outcome.ok || !results.length || outcome.weak === true);
    }
  }
  return {
    ...base,
    recallAt5: rate(recall, base.n),
    answerInSnippetPrecision: rate(precisionHits, returned),
    answerCoverage: rate(answerQueries, base.n),
    coverage: rate(covered, base.n),
    weakEmptyHonesty: rate(honest, weak),
    tokensPerQuery: ratio(base.totalTokens, base.n),
    tokensPerRecallHit: ratio(base.totalTokens, recall),
  };
}

export function scoreFetch(samples: FetchSample[]) {
  const attempted = samples.filter(s => !s.outcome.skipped);
  const base = common(attempted.map(s => s.outcome), samples.length - attempted.length);
  const counts = { 1: { hits: 0, n: 0 }, 2: { hits: 0, n: 0 }, 3: { hits: 0, n: 0 } };
  let tp = 0, fp = 0, tn = 0, fn = 0, wallN = 0, wallFp = 0;
  for (const { task, outcome } of attempted) {
    const detectedWall = isBotWall(outcome.content);
    const retrieved = contains(outcome.content, task.probe) && !detectedWall;
    counts[task.tier].n++;
    counts[task.tier].hits += Number(retrieved);
    if (retrieved) { if (outcome.ok) tp++; else fn++; }
    else { if (outcome.ok) fp++; else tn++; }
    // Tier 3 tasks are the known protection/honesty population. A probe match
    // still counts as real retrieval; tier alone never overrides real content.
    if (detectedWall || (task.tier === 3 && !retrieved)) { wallN++; wallFp += Number(outcome.ok); }
  }
  const tiers = { 1: rate(counts[1].hits, counts[1].n), 2: rate(counts[2].hits, counts[2].n), 3: rate(counts[3].hits, counts[3].n) };
  let weightedN = 0, weightedHits = 0, low = 0, high = 0;
  for (const tier of [1, 2, 3] as const) {
    const weight = tier * tiers[tier].n;
    weightedN += weight;
    weightedHits += tier * tiers[tier].hits;
    low += weight * (tiers[tier].interval?.[0] ?? 0);
    high += weight * (tiers[tier].interval?.[1] ?? 0);
  }
  return {
    ...base, retrieval: rate(tp + fn, base.n), tiers,
    weighted: { n: base.n, weightedN, value: weightedN ? weightedHits / weightedN : null,
      interval: weightedN ? [low / weightedN, high / weightedN] : null,
      intervalMethod: "weighted per-tier Wilson bounds; descriptive, not a pooled binomial CI" },
    honesty: { tp, fp, tn, fn, falsePositiveRate: rate(fp, fp + tn), botWallFalsePositiveRate: rate(wallFp, wallN) },
    tokensPerSuccess: ratio(base.totalTokens, tp + fn),
  };
}
