import type { MemoryEntry, MemoryKind } from "./types.js";

/** Per-kind half-life in days. null = never decays. Layer 2 entries use 4× effective half-life. */
export const HALF_LIFE_DAYS: Record<MemoryKind, number | null> = {
  constraint: null,
  preference: 180,
  fact: 90,
  decision: 365,
  mistake: 60,
  pattern: 365,
};

const LAYER2_HALF_LIFE_MULTIPLIER = 4;
const MS_PER_DAY = 86_400_000;

export function effectiveConfidence(entry: MemoryEntry, now: number): number {
  if (entry.pinned) return entry.confidence;

  const halfLifeDays = HALF_LIFE_DAYS[entry.kind];
  if (halfLifeDays === null) return entry.confidence;

  const ageDays = (now - entry.created_at) / MS_PER_DAY;
  let effectiveHalfLife = halfLifeDays;
  if (entry.layer === 2) {
    effectiveHalfLife *= LAYER2_HALF_LIFE_MULTIPLIER;
  }

  const decay = Math.pow(0.5, ageDays / effectiveHalfLife);
  return entry.confidence * decay;
}
