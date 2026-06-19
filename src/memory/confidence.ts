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

/** Per-kind weights when ranking digest entries. */
export const KIND_WEIGHTS: Record<MemoryKind, number> = {
  constraint: 1.3,
  fact: 1.0,
  preference: 1.2,
  pattern: 1.1,
  decision: 0.9,
  mistake: 0.7,
};

export function digestScore(entry: MemoryEntry, now: number): number {
  return effectiveValidity(entry, now) * (KIND_WEIGHTS[entry.kind] ?? 1.0);
}

export function effectiveValidity(entry: MemoryEntry, now: number): number {
  if (entry.pinned) return entry.validity;

  const halfLifeDays = HALF_LIFE_DAYS[entry.kind];
  if (halfLifeDays === null) return entry.validity;

  const ageDays = (now - entry.created_at) / MS_PER_DAY;
  let effectiveHalfLife = halfLifeDays;
  if (entry.layer === 2) {
    effectiveHalfLife *= LAYER2_HALF_LIFE_MULTIPLIER;
  }

  const decay = Math.pow(0.5, ageDays / effectiveHalfLife);
  return entry.validity * decay;
}

