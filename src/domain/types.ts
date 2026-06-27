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
  /** Share for recent verbatim turns and recent scored units. */
  recentTurns: number;
  /** Share for decisions (checkpoint decisions section). */
  decisions: number;
  /** Share for artifact cards and older scored content. */
  artifacts: number;
  /** Share for narrative (checkpoint narrative section). */
  narrative: number;
}

/** Domain-specific keyword and tool-pattern scoring for task classification. */
export interface DomainClassifier {
  readonly domainId: string;
  /** Priority order when blended scores tie (highest priority first). */
  readonly tieBreakOrder: readonly string[];
  scoreKeywords(userInput: string): TaskScoreMap;
  scoreTools(input: TaskClassificationInput): TaskScoreMap;
  /** Return fractional budget allocation for the given task type. Values sum to 1.0. */
  getBudgetAllocation(taskType: string): BudgetAllocation;
}
