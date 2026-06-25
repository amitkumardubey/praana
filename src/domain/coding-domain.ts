/**
 * Coding Domain — the single home for all coding-specific knowledge.
 *
 * ADR-005 C4 / Issue #95: every coding-specific assumption (synonym maps,
 * test-command detection, content-type predicates, tool→type mapping,
 * distiller factory, git/test-output parsers) lives behind named exports
 * in this module. The context engine and skill ranker consume it through
 * these imports — not a plugin system, just a module boundary.
 */

import { DiffDistiller } from "../distillers/git-diff.js";
import { GenericDistiller, LogDistiller } from "../distillers/generic.js";
import { TestDistiller } from "../distillers/npm-test.js";
import { SearchDistiller } from "../distillers/rg-results.js";
import { BuildDistiller } from "../distillers/tsc-errors.js";
import { DistillerRegistry } from "../context-engine/distiller.js";
import type { ContentType } from "../context-engine/types.js";
import type {
  DomainClassifier,
  TaskClassificationInput,
  TaskScoreMap,
  CodingTaskType,
} from "./types.js";

// ---------------------------------------------------------------------------
// Synonyms — coding/devops vocabulary for BM25 expansion
// ---------------------------------------------------------------------------

export const CODING_SYNONYMS: Record<string, string[]> = {
  deploy: ["launch", "release", "rollout", "publish"],
  database: ["db", "postgres", "mysql", "sql", "rds", "dynamodb"],
  container: ["docker", "ecs", "kubernetes", "k8s", "pod"],
  aws: ["amazon", "ec2", "s3", "lambda", "cloud"],
  test: ["testing", "spec", "assert", "verify", "check"],
  build: ["compile", "bundle", "package", "construct"],
  error: ["error", "failure", "bug", "issue", "crash", "exception"],
  fix: ["fix", "repair", "patch", "resolve", "correct"],
  code: ["code", "source", "implementation", "program"],
  review: ["review", "audit", "inspect", "check"],
  config: ["configuration", "setup", "settings", "options"],
  monitor: ["monitoring", "observe", "watch", "track", "metrics"],
  auth: ["authentication", "login", "oauth", "sso", "identity"],
  api: ["rest", "graphql", "endpoint", "service", "http"],
};

// ---------------------------------------------------------------------------
// Test-command detection
// ---------------------------------------------------------------------------

export function isTestCommand(command: string): boolean {
  return /\b(npm test|pnpm test|yarn test|vitest|pytest|cargo test|go test)\b/i.test(
    command,
  );
}

// ---------------------------------------------------------------------------
// Content-type predicates (coding-specific regexes extracted from classify.ts)
// ---------------------------------------------------------------------------

export function isDiffContent(text: string): boolean {
  return /^diff --git/m.test(text) || /^@@ -\d+/m.test(text);
}

export function isTestOutputContent(text: string): boolean {
  return /\b(PASS|FAIL|✓|✗)\b/.test(text) && /\btests?\b/i.test(text);
}

export function isBuildOutputContent(text: string): boolean {
  return /error TS\d+:/.test(text) || /^error:.+:\d+/m.test(text);
}

export function isCodeContent(text: string): boolean {
  return (
    /^(import |export |function |class |const |let |def )/m.test(text) ||
    /```[\s\S]*```/.test(text)
  );
}

export function hasTestMarkers(text: string): boolean {
  return /\b(PASS|FAIL|✓|✗|tests?)\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Tool → content-type inference
// ---------------------------------------------------------------------------

export function inferContentTypeFromTool(
  sourceTool: string,
  command: string | undefined,
): ContentType | null {
  if (!command) return null;
  const normalized = command.trim();
  if (!normalized) return null;

  if (
    sourceTool === "shell" &&
    /(^|\s)(rg|grep|ag|ack)(\s|$)/.test(normalized)
  ) {
    return "search_results";
  }
  if (sourceTool === "shell" && /(^|\s)git\s+(diff|show)(\s|$)/.test(normalized)) {
    return "diff";
  }
  if (
    sourceTool === "shell" &&
    /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)(\s|$|:)/.test(
      normalized,
    )
  ) {
    return "test_output";
  }
  if (
    sourceTool === "shell" &&
    /(^|\s)(tsc|vue-tsc|npm\s+run\s+(build|typecheck)|pnpm\s+(build|typecheck))(\s|$)/.test(
      normalized,
    )
  ) {
    return "build_output";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Git / test-output parsers
// ---------------------------------------------------------------------------

const TEST_FAIL_RE = /(\d+)\s+failing|FAIL|failed/i;

export function extractCommitMessage(resultText?: string): string {
  if (!resultText) return "changes";
  try {
    const parsed = JSON.parse(resultText) as { stdout?: string; output?: string };
    const stdout = parsed.stdout ?? parsed.output ?? resultText;
    const firstLine = stdout.split("\n").map((l) => l.trim()).find(Boolean);
    return firstLine?.slice(0, 120) ?? "changes";
  } catch {
    const firstLine = resultText.split("\n").map((l) => l.trim()).find(Boolean);
    return firstLine?.slice(0, 120) ?? "changes";
  }
}

export function extractFailureCount(resultText?: string): string {
  if (!resultText) return "unknown count";
  const match = resultText.match(TEST_FAIL_RE);
  if (match?.[1]) return `${match[1]} failures`;
  if (/fail/i.test(resultText)) return "failures detected";
  return "failures detected";
}

// ---------------------------------------------------------------------------
// Distiller registry factory
// ---------------------------------------------------------------------------

export function createDefaultDistillerRegistry(): DistillerRegistry {
  const registry = new DistillerRegistry();
  registry.register(new DiffDistiller());
  registry.register(new TestDistiller());
  registry.register(new BuildDistiller());
  registry.register(new SearchDistiller());
  registry.register(new LogDistiller());
  registry.register(new GenericDistiller());
  return registry;
}

// ---------------------------------------------------------------------------
// Task type classification (Issue #89)
// ---------------------------------------------------------------------------

export const CODING_TASK_CLUSTERS = {
  testing: ["test", "spec", "assert", "verify", "coverage"],
  debugging: ["error", "bug", "fix", "crash", "fail", "broken"],
  refactoring: ["refactor", "restructure", "reorganize", "clean", "simplify"],
  implementing: ["implement", "create", "add", "build", "new feature"],
  reviewing: ["review", "audit", "inspect", "feedback", "check"],
} as const;

type ScoredCodingTaskType = Exclude<CodingTaskType, "general">;

const CODING_TASK_TIE_BREAK: readonly ScoredCodingTaskType[] = [
  "debugging",
  "testing",
  "implementing",
  "refactoring",
  "reviewing",
];

const TEST_PATH_RE = /\.(test|spec)\./i;

/** Number of turns (including current) used for tool-pattern scoring. */
export const RECENT_TURNS_WINDOW = 3;

const CODING_TASK_TYPE_SET = new Set<string>([
  ...Object.keys(CODING_TASK_CLUSTERS),
  "general",
]);

/** Narrow a domain-agnostic classification label to a known coding task type. */
export function narrowCodingTaskType(taskType: string): CodingTaskType {
  return CODING_TASK_TYPE_SET.has(taskType)
    ? (taskType as CodingTaskType)
    : "general";
}

function recentTurnMinTurn(currentTurn: number): number {
  return Math.max(0, currentTurn - RECENT_TURNS_WINDOW + 1);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countKeywordMatches(text: string, keyword: string): number {
  const normalized = text.toLowerCase();
  const pattern = new RegExp(`\\b${escapeRegex(keyword.toLowerCase())}\\b`, "gi");
  return (normalized.match(pattern) ?? []).length;
}

export function scoreCodingTaskKeywords(userInput: string): TaskScoreMap {
  const scores: TaskScoreMap = {};
  if (!userInput.trim()) return scores;

  for (const [taskType, keywords] of Object.entries(CODING_TASK_CLUSTERS)) {
    let total = 0;
    for (const keyword of keywords) {
      total += countKeywordMatches(userInput, keyword);
    }
    if (total > 0) {
      scores[taskType] = total;
    }
  }
  return scores;
}

function recentTurnRecords(
  turnRecords: TaskClassificationInput["turnRecords"],
  currentTurn: number,
): TaskClassificationInput["turnRecords"] {
  const minTurn = recentTurnMinTurn(currentTurn);
  return turnRecords.filter((record) => record.turn >= minTurn);
}

function recentActivityEntries(
  activityEntries: TaskClassificationInput["activityEntries"],
  currentTurn: number,
): TaskClassificationInput["activityEntries"] {
  const minTurn = recentTurnMinTurn(currentTurn);
  return activityEntries.filter((entry) => entry.turn >= minTurn);
}

function addScore(scores: TaskScoreMap, taskType: string, points: number): void {
  if (points <= 0) return;
  scores[taskType] = (scores[taskType] ?? 0) + points;
}

function isErrorSearchCommand(command: string): boolean {
  return (
    /(^|\s)(rg|grep|ag|ack)(\s|$)/.test(command) &&
    /\b(error|fail|exception|crash|stack)\b/i.test(command)
  );
}

export function scoreCodingTaskTools(input: TaskClassificationInput): TaskScoreMap {
  const scores: TaskScoreMap = {};
  const records = recentTurnRecords(input.turnRecords, input.currentTurn);
  const activities = recentActivityEntries(input.activityEntries, input.currentTurn);

  let editFileCount = 0;
  let writeFileCount = 0;
  let readFileCount = 0;
  let searchCodeCount = 0;

  for (const record of records) {
    const hasErrorToolCall = record.toolCalls.some((tc) => tc.isError);
    if (record.errors.length > 0 && !hasErrorToolCall) {
      addScore(scores, "debugging", 2);
    }

    for (const path of record.filesWritten) {
      if (TEST_PATH_RE.test(path)) {
        addScore(scores, "testing", 1);
      } else {
        addScore(scores, "implementing", 1);
      }
    }

    for (const tc of record.toolCalls) {
      const command =
        typeof tc.args.command === "string" ? tc.args.command : undefined;
      const path = typeof tc.args.path === "string" ? tc.args.path : undefined;

      if (tc.tool === "shell" && command) {
        if (isTestCommand(command)) {
          addScore(scores, "testing", 2);
        }
        if (isErrorSearchCommand(command)) {
          addScore(scores, "debugging", 1);
        }
      }

      if (tc.isError) {
        addScore(scores, "debugging", 2);
      }

      if (tc.tool === "edit_file" && !tc.isError) {
        editFileCount += 1;
      }
      if (tc.tool === "write_file" && !tc.isError) {
        writeFileCount += 1;
        if (!path || !TEST_PATH_RE.test(path)) {
          addScore(scores, "implementing", 2);
        }
      }
      if (tc.tool === "read_file" && !tc.isError) {
        readFileCount += 1;
      }
      if (tc.tool === "search_code" && !tc.isError) {
        searchCodeCount += 1;
      }
    }
  }

  for (const entry of activities) {
    if (entry.type === "test_fail" || entry.type === "test_pass") {
      addScore(scores, "testing", 2);
    }
    if (entry.type === "error_fixed") {
      addScore(scores, "debugging", 2);
    }
    if (entry.type === "file_written") {
      addScore(scores, "implementing", 1);
    }
  }

  if (editFileCount >= 2 && writeFileCount === 0) {
    addScore(scores, "refactoring", 3);
  }

  const reviewReads = readFileCount + searchCodeCount;
  if (reviewReads >= 2 && writeFileCount === 0 && editFileCount === 0) {
    addScore(scores, "reviewing", reviewReads);
  }

  return scores;
}

export const codingDomainClassifier: DomainClassifier = {
  domainId: "coding",
  tieBreakOrder: CODING_TASK_TIE_BREAK,
  scoreKeywords: scoreCodingTaskKeywords,
  scoreTools: scoreCodingTaskTools,
};
