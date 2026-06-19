import type { SummarizerLLM } from "./types.js";

const NEGATION_PATTERN =
  /\b(not|never|no|without|isn't|aren't|doesn't|don't|won't|cannot|can't|missing|absent|disabled)\b/i;

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

export function heuristicContradiction(existing: string, incoming: string): boolean {
  const a = normalize(existing);
  const b = normalize(incoming);
  const negA = NEGATION_PATTERN.test(a);
  const negB = NEGATION_PATTERN.test(b);
  if (negA === negB) return false;

  const shared = terms(a).filter((t) => terms(b).includes(t));
  return shared.length >= 2;
}

export async function isContradiction(
  existing: string,
  incoming: string,
  llm?: SummarizerLLM | null,
): Promise<boolean> {
  if (heuristicContradiction(existing, incoming)) return true;
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
