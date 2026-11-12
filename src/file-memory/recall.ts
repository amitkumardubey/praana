import { sanitizeDescription, searchTokens, type Memory } from "./format.js";
import type { MemoryScope } from "./paths.js";

export type ScopedMemory = Memory & { scope: MemoryScope };
export interface RecallMatch {
  name: string;
  scope: MemoryScope;
  description: string;
  snippet: string;
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
    .map(({ memory }) => ({ name: memory.name, scope: memory.scope, description: sanitizeDescription(memory.description), snippet: sanitizeDescription(memory.body) }));
}
