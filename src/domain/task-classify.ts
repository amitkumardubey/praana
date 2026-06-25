import { codingDomainClassifier } from "./coding-domain.js";
import type {
  CodingTaskType,
  DomainClassifier,
  TaskClassificationInput,
  TaskClassificationResult,
  TaskScoreMap,
} from "./types.js";

const KEYWORD_WEIGHT = 0.6;
const TOOL_WEIGHT = 0.4;
const STRONG_SIGNAL_THRESHOLD = 2;

export function getDefaultDomainClassifier(): DomainClassifier {
  return codingDomainClassifier;
}

function topScoredTask(
  scores: TaskScoreMap,
  tieBreakOrder: readonly string[],
): { taskType: CodingTaskType; score: number } | null {
  const entries = Object.entries(scores).filter(([, score]) => score > 0);
  if (entries.length === 0) return null;

  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const aIdx = tieBreakOrder.indexOf(a[0]);
    const bIdx = tieBreakOrder.indexOf(b[0]);
    const aRank = aIdx === -1 ? tieBreakOrder.length : aIdx;
    const bRank = bIdx === -1 ? tieBreakOrder.length : bIdx;
    return aRank - bRank;
  });

  const [taskType, score] = entries[0];
  return { taskType: taskType as CodingTaskType, score };
}

function blendScores(
  keywordScores: TaskScoreMap,
  toolScores: TaskScoreMap,
): TaskScoreMap {
  const blended: TaskScoreMap = {};
  const keys = new Set([
    ...Object.keys(keywordScores),
    ...Object.keys(toolScores),
  ]);

  for (const key of keys) {
    const blendedScore =
      (keywordScores[key] ?? 0) * KEYWORD_WEIGHT +
      (toolScores[key] ?? 0) * TOOL_WEIGHT;
    if (blendedScore > 0) {
      blended[key] = blendedScore;
    }
  }

  return blended;
}

// Scores at STRONG_SIGNAL_THRESHOLD (2) ≈ 0.5 confidence; 4+ → max.
function normalizeConfidence(score: number): number {
  return Math.min(1, Math.max(0, score / 4));
}

export function classifyTask(
  classifier: DomainClassifier,
  input: TaskClassificationInput,
): TaskClassificationResult {
  const keywordScores = classifier.scoreKeywords(input.userInput);
  const toolScores = classifier.scoreTools(input);

  const keywordWinner = topScoredTask(keywordScores, classifier.tieBreakOrder);
  const toolWinner = topScoredTask(toolScores, classifier.tieBreakOrder);

  if (!keywordWinner && !toolWinner) {
    return { taskType: "general", confidence: 0, source: "fallback" };
  }

  if (
    keywordWinner &&
    (keywordWinner.score >= STRONG_SIGNAL_THRESHOLD ||
      !toolWinner ||
      keywordWinner.score > toolWinner.score)
  ) {
    return {
      taskType: keywordWinner.taskType,
      confidence: normalizeConfidence(keywordWinner.score),
      source: "keywords",
    };
  }

  if (
    toolWinner &&
    (toolWinner.score >= STRONG_SIGNAL_THRESHOLD ||
      !keywordWinner ||
      toolWinner.score > keywordWinner.score)
  ) {
    return {
      taskType: toolWinner.taskType,
      confidence: normalizeConfidence(toolWinner.score),
      source: "tools",
    };
  }

  const blended = blendScores(keywordScores, toolScores);
  const blendedWinner = topScoredTask(blended, classifier.tieBreakOrder);
  if (!blendedWinner) {
    return { taskType: "general", confidence: 0, source: "fallback" };
  }

  return {
    taskType: blendedWinner.taskType,
    confidence: normalizeConfidence(blendedWinner.score),
    source: "blended",
  };
}
