// ============================================================
// PRAANA Memory — Deduplication & Contradiction Detection
// ============================================================
// M7 (Issues #71, #91): Layered contradiction detection with fallthrough.
// Three layers (cheapest → most expensive):
//   1. Subject-aware heuristic (negation polarity + head noun match)
//   2. Embedding distance + replacement signal (deterministic, cached, ~15ms)
//   3. LLM fallback (only for ambiguous cases)
//
// M6 verified (2026-06-19): No hash embedder fallback. See embedder-factory.ts.

import type { SummarizerLLM, Embedder } from "./types.js";
import nlp from "compromise";

const NEGATION_PATTERN =
  /\b(not|never|no|without|isn't|aren't|doesn't|don't|won't|cannot|can't|missing|absent|disabled)\b/i;

/**
 * M7 Layer 2: LRU cache for embeddings to avoid recomputation.
 * Max 100 entries (~38-76KB depending on embedder dimension).
 * 
 * Implementation: Map-based LRU with access-order tracking.
 * On get(), moves item to end. On set(), evicts oldest if at capacity.
 */
class EmbeddingCache {
  private cache = new Map<string, Float32Array>();
  private readonly maxSize = 100;

  get(text: string): Float32Array | undefined {
    const normalized = normalizeMemoryContent(text);
    const vec = this.cache.get(normalized);
    if (vec) {
      // Move to end (LRU)
      this.cache.delete(normalized);
      this.cache.set(normalized, vec);
    }
    return vec;
  }

  set(text: string, vec: Float32Array): void {
    const normalized = normalizeMemoryContent(text);
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(normalized)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(normalized, vec);
  }

  clear(): void {
    this.cache.clear();
  }
}

// Module-level singleton cache for M7 Layer 2
const embeddingCache = new EmbeddingCache();

/**
 * Cosine similarity between two vectors (0 = orthogonal, 1 = identical).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// Replacement cue patterns for M7 Layer 2
const REPLACEMENT_PATTERN = /\b(switch.*to|replace.*with|instead of|moved? (?:from|to)|no longer|now using)\b/i;

/**
 * M7 Layer 2: Embedding-based contradiction detection with replacement signal.
 * Checks semantic similarity + explicit replacement cues (deterministic, cached).
 */
async function contradictionLayer2(
  existing: string,
  incoming: string,
  embedder: Embedder | null,
): Promise<boolean> {
  if (!embedder) return false; // Skip layer if no embedder

  // Check cache first
  let vecA = embeddingCache.get(existing);
  let vecB = embeddingCache.get(incoming);

  // Compute embeddings if not cached
  if (!vecA) {
    vecA = await embedder.embed(existing);
    embeddingCache.set(existing, vecA);
  }
  if (!vecB) {
    vecB = await embedder.embed(incoming);
    embeddingCache.set(incoming, vecB);
  }

  const similarity = cosineSimilarity(vecA, vecB);

  // High similarity + replacement cue = contradiction
  if (similarity > CONTRADICTION_MATCH_THRESHOLD) {
    const combined = `${existing} ${incoming}`;
    return REPLACEMENT_PATTERN.test(combined);
  }

  return false;
}

export function normalizeMemoryContent(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** @deprecated alias — use normalizeMemoryContent */
function normalize(text: string): string {
  return normalizeMemoryContent(text);
}

export function scopesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((scope, index) => scope === sortedB[index]);
}

export function scopeGroupKey(scopes: string[]): string {
  return [...scopes].sort().join("\0");
}

function terms(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((w) => w.length >= 3);
}

/**
 * Extract the primary head noun from a statement for subject-matching (M7 Layer 1).
 * Returns the first noun found, or null if no nouns detected.
 */
export function extractHeadNoun(text: string): string | null {
  if (!text || text.trim().length === 0) return null;
  const nouns = nlp(text).nouns().out("array") as string[];
  if (nouns.length === 0) return null;
  // Extract just the head noun (last word of the noun phrase)
  const firstNoun = nouns[0].trim();
  const words = firstNoun.split(/\s+/);
  return normalize(words[words.length - 1]);
}

/**
 * M7 Layer 1: Subject-aware heuristic contradiction detection.
 * Checks for negation polarity flip + subject match to eliminate false positives
 * (e.g., "uses PostgreSQL" vs "uses MongoDB" should NOT be contradictory).
 */
export function heuristicContradiction(existing: string, incoming: string): boolean {
  const a = normalize(existing);
  const b = normalize(incoming);
  const negA = NEGATION_PATTERN.test(a);
  const negB = NEGATION_PATTERN.test(b);
  
  // Same polarity = not contradictory
  if (negA === negB) return false;

  // Check if same subject (head noun match)
  const subjectA = extractHeadNoun(a);
  const subjectB = extractHeadNoun(b);
  if (subjectA && subjectB && subjectA === subjectB) {
    return true; // Same subject, opposite polarity → contradiction
  }

  // Fallback: ≥3 shared terms with at least one shared noun
  const termsA = terms(a);
  const termsB = terms(b);
  const shared = termsA.filter((t) => termsB.includes(t));
  if (shared.length >= 3) {
    const nounsA = nlp(a).nouns().out("array") as string[];
    const nounsB = nlp(b).nouns().out("array") as string[];
    const normalizedNounsA = nounsA.map((n) => normalize(n.split(/\s+/).pop() || ""));
    const normalizedNounsB = nounsB.map((n) => normalize(n.split(/\s+/).pop() || ""));
    const sharedNouns = normalizedNounsA.filter((n) => normalizedNounsB.includes(n));
    return sharedNouns.length > 0;
  }

  return false;
}

/**
 * M7 layered contradiction detection with fallthrough:
 * - Layer 1: Subject-aware heuristic (cheapest)
 * - Layer 2: Embedding distance + replacement signal (deterministic, cached)
 * - Layer 3: LLM (fallback for ambiguous cases)
 */
export async function isContradiction(
  existing: string,
  incoming: string,
  llm?: SummarizerLLM | null,
  embedder?: Embedder | null,
): Promise<boolean> {
  // Layer 1: heuristic
  if (heuristicContradiction(existing, incoming)) return true;

  // Layer 2: embedding + replacement signal
  if (embedder) {
    if (await contradictionLayer2(existing, incoming, embedder)) return true;
  }

  // Layer 3: LLM fallback
  if (!llm || !(await llm.available())) return false;

  try {
    const raw = await llm.complete({
      system:
        "You classify whether two memory statements contradict each other. " +
        'Output ONLY JSON: {"contradicts": true|false}.',
      prompt: `Existing: ${existing}\nIncoming: ${incoming}`,
      temperature: 0,
      maxTokens: 32,
      json: true,
      timeoutMs: 10_000,
    });
    const parsed = JSON.parse(raw) as { contradicts?: boolean };
    return parsed.contradicts === true;
  } catch {
    return false;
  }
}

export const DUPLICATE_MATCH_THRESHOLD = 0.92;
export const CONTRADICTION_MATCH_THRESHOLD = 0.80;

export function isNearDuplicate(existing: string, incoming: string, score: number): boolean {
  if (normalize(existing) === normalize(incoming)) return true;
  if (heuristicContradiction(existing, incoming)) return false;
  return score >= DUPLICATE_MATCH_THRESHOLD;
}
