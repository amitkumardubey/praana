import type { ActivityEntry, TurnRecord } from "../context-engine/types.js";

export type CodingTaskType =
  | "testing"
  | "debugging"
  | "refactoring"
  | "implementing"
  | "reviewing"
  | "general";

export type TaskClassificationSource =
  | "keywords"
  | "tools"
  | "blended"
  | "fallback";

export interface TaskClassificationInput {
  userInput: string;
  turnRecords: TurnRecord[];
  activityEntries: ActivityEntry[];
  currentTurn: number;
}

export interface TaskClassificationResult {
  /** Domain-agnostic task label; coding callers narrow via narrowCodingTaskType(). */
  taskType: string;
  confidence: number;
  source: TaskClassificationSource;
}

export type TaskScoreMap = Record<string, number>;

/** Per-task-type fractional budget allocation. All five values must sum to 1.0. */
export interface BudgetAllocation {
  /** Share for error context (checkpoint open/fixed errors). */
  errors: number;
  /** Share for verbatim recent-turn section. */
  verbatimTurns: number;
  /** Share for decisions (checkpoint decisions section). */
  decisions: number;
  /** Share for artifact cards and scored content (recent and older units). */
  artifacts: number;
  /** Share for narrative (checkpoint narrative section). */
  narrative: number;
}

/** Domain-specific keyword and tool-pattern scoring for task classification. */
export function validateBudgetAllocation(alloc: BudgetAllocation): void {
  const sum = alloc.errors + alloc.verbatimTurns + alloc.decisions + alloc.artifacts + alloc.narrative;
  if (Math.abs(sum - 1.0) > 0.01) {
    throw new Error(
      `BudgetAllocation values must sum to 1.0 (got ${sum.toFixed(4)} for ${JSON.stringify(alloc)})`,
    );
  }
  for (const [key, value] of Object.entries(alloc)) {
    if (value < 0) {
      throw new Error(`BudgetAllocation.${key} cannot be negative (got ${value})`);
    }
  }
}

export interface DomainClassifier {
  readonly domainId: string;
  /** Priority order when blended scores tie (highest priority first). */
  readonly tieBreakOrder: readonly string[];
  scoreKeywords(userInput: string): TaskScoreMap;
  scoreTools(input: TaskClassificationInput): TaskScoreMap;
  /** Return fractional budget allocation for the given task type. Values sum to 1.0. */
  getBudgetAllocation(taskType: string): BudgetAllocation;
}
