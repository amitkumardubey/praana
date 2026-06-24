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
