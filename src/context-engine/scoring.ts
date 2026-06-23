import { bm25Relevance } from "./bm25.js";
import { estimateTokens } from "./summarize.js";
import type { ContextEngineScoringConfig } from "../types.js";
import type { ContextUnit, ScoreBreakdown, ScoredContextUnit } from "./types.js";

const PIN_BOOST = 1000;

export function recencyScore(ageTurns: number): number {
  return 1 / (1 + Math.max(0, ageTurns));
}

export function scoreContextUnit(
  unit: ContextUnit,
  currentTurn: number,
  userInput: string,
  weights: ContextEngineScoringConfig,
  hydratedTexts?: string[],
): { score: number; breakdown: ScoreBreakdown } {
  const pin = unit.pinned ? PIN_BOOST * weights.w_pin : 0;
  const age = Math.max(0, currentTurn - unit.sourceTurn);
  const recency = recencyScore(age) * weights.w_recency;
  const relevance = bm25Relevance(userInput, unit.content) * weights.w_relevance;

  let hydrate_boost = 0;
  const wHydrate = weights.w_hydrate_boost ?? 0;
  if (wHydrate > 0 && hydratedTexts && hydratedTexts.length > 0) {
    // Score how well this unit's content relates to each hydrated object's text.
    // A unit from a turn that discussed the same object scores higher.
    const maxBoost = Math.max(...hydratedTexts.map((t) => bm25Relevance(t, unit.content)));
    hydrate_boost = maxBoost * wHydrate;
  }

  return {
    score: pin + recency + relevance + hydrate_boost,
    breakdown: { pin, recency, relevance, hydrate_boost },
  };
}

export function rankContextUnits(
  units: ContextUnit[],
  currentTurn: number,
  userInput: string,
  weights: ContextEngineScoringConfig,
  hydratedTexts?: string[],
): ScoredContextUnit[] {
  return units
    .map((unit) => {
      const scored = scoreContextUnit(unit, currentTurn, userInput, weights, hydratedTexts);
      return { ...unit, ...scored };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function selectUnitsWithinBudget(
  ranked: ScoredContextUnit[],
  tokenBudget: number,
): { included: ScoredContextUnit[]; excluded: ScoredContextUnit[] } {
  const included: ScoredContextUnit[] = [];
  const excluded: ScoredContextUnit[] = [];
  let used = 0;

  for (const unit of ranked) {
    if (unit.pinned) {
      included.push(unit);
      used += unit.tokens;
      continue;
    }
    if (used + unit.tokens <= tokenBudget) {
      included.push(unit);
      used += unit.tokens;
    } else {
      excluded.push(unit);
    }
  }

  return { included, excluded };
}

export function unitTokens(content: string): number {
  return estimateTokens(content);
}
