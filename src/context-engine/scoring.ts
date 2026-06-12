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
): { score: number; breakdown: ScoreBreakdown } {
  const pin = unit.pinned ? PIN_BOOST * weights.w_pin : 0;
  const age = Math.max(0, currentTurn - unit.sourceTurn);
  const recency = recencyScore(age) * weights.w_recency;
  const relevance = bm25Relevance(userInput, unit.content) * weights.w_relevance;
  return {
    score: pin + recency + relevance,
    breakdown: { pin, recency, relevance },
  };
}

export function rankContextUnits(
  units: ContextUnit[],
  currentTurn: number,
  userInput: string,
  weights: ContextEngineScoringConfig,
): ScoredContextUnit[] {
  return units
    .map((unit) => {
      const scored = scoreContextUnit(unit, currentTurn, userInput, weights);
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
