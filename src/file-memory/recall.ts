import { searchTokens, type Memory } from "./format.js";
import type { MemoryScope } from "./paths.js";

export type ScopedMemory = Memory & { scope: MemoryScope };
export interface RecallMatch {
  name: string;
  scope: MemoryScope;
  description: string;
  snippet: string;
}

function cleanRecallText(text: string): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(cleaned).slice(0, 300).join("");
}

function matchingWindow(text: string, tokens: readonly string[]): string | null {
  const normalized = text.normalize("NFC");
  const queryTokens = new Set(tokens);
  // Query tokens are already filtered; scan corpus words once, keeping their positions.
  for (const match of normalized.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    if (!queryTokens.has(match[0].toLowerCase())) continue;
    const points = Array.from(normalized);
    const centre = Array.from(normalized.slice(0, match.index)).length + Math.floor(Array.from(match[0]).length / 2);
    const start = Math.max(0, Math.min(centre - 150, points.length - 300));
    return points.slice(start, start + 300).join("");
  }
  return null;
}

/** Each distinct matching query token scores 9 in name, 3 in description, 1 in body.
 * Repeated query/corpus tokens do not inflate scores. Scope is the final tie-break. */
export function rankMemories(memories: readonly ScopedMemory[], query: string): RecallMatch[] {
  const tokens = searchTokens(query);
  return memories.map((memory) => {
    const fields = [memory.name, memory.description, memory.body].map((text) => new Set(searchTokens(text)));
    const score = fields.reduce((sum, field, i) => sum + [9, 3, 1][i]! * tokens.filter((token) => field.has(token)).length, 0);
    return { memory, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.memory.updated.localeCompare(a.memory.updated) || a.memory.name.localeCompare(b.memory.name) || a.memory.scope.localeCompare(b.memory.scope))
    .slice(0, 5)
    .map(({ memory }) => ({ name: memory.name, scope: memory.scope, description: cleanRecallText(memory.description), snippet: cleanRecallText(matchingWindow(memory.body, tokens) ?? matchingWindow(memory.description, tokens) ?? memory.body) }));
}
