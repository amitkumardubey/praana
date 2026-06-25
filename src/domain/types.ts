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
  taskType: string;
  confidence: number;
  source: TaskClassificationSource;
}

export type TaskScoreMap = Record<string, number>;

/** Domain-specific keyword and tool-pattern scoring for task classification. */
export interface DomainClassifier {
  readonly domainId: string;
  /** Priority order when blended scores tie (highest priority first). */
  readonly tieBreakOrder: readonly string[];
  scoreKeywords(userInput: string): TaskScoreMap;
  scoreTools(input: TaskClassificationInput): TaskScoreMap;
}
