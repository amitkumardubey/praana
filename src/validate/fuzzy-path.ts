/**
 * Fuzzy path suggestions for missing-file pre-validation (#300).
 */

import { basename } from "node:path";
import { pathInRoot } from "../lsp/workspace-roots.js";

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

function maxDistance(name: string): number {
  return Math.max(2, Math.ceil(0.3 * name.length));
}

function isSuffixMatch(query: string, candidate: string): boolean {
  return candidate.endsWith(query) || candidate.endsWith(`/${query}`);
}

export function suggestPaths(
  query: string,
  candidates: string[],
  cap = 5,
  sessionRoot?: string,
): string[] {
  const q = query.replace(/\\/g, "/").replace(/^\/+/, "");
  const qBase = basename(q);
  const scored: Array<{ path: string; rank: number; dist: number }> = [];
  const seen = new Set<string>();

  for (const raw of candidates) {
    if (!raw || seen.has(raw)) continue;
    if (raw.includes("node_modules/")) continue;
    if (sessionRoot && !pathInRoot(raw, sessionRoot) && raw !== sessionRoot) {
      continue;
    }
    seen.add(raw);
    const base = basename(raw);
    let rank = 3;
    let dist = levenshtein(qBase, base);
    if (base === qBase) {
      rank = 0;
      dist = 0;
    } else if (isSuffixMatch(q, raw)) {
      rank = 1;
      dist = 0;
    } else if (dist > maxDistance(qBase)) {
      continue;
    }
    scored.push({ path: raw, rank, dist });
  }

  scored.sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.path.localeCompare(b.path));
  return scored.slice(0, cap).map((s) => s.path);
}
