/**
 * Workflow pattern tracking — issue #92.
 *
 * Learns context needs from past sessions by recording which tools the agent
 * used and which artifact types were important for each task type. At session
 * end, a pattern is extracted and stored in the context-engine SQLite DB.
 * At compile time, matching patterns inject a small "Workflow Context" section
 * into the prompt so the LLM knows which tools and artifacts have been useful
 * in similar past sessions.
 *
 * Patterns expire after WORKFLOW_PATTERN_EXPIRY_DAYS of non-use (pruned at
 * session-end shutdown).
 */

import type { Database } from "bun:sqlite";
import {
  deleteExpiredWorkflowPatterns,
  listWorkflowPatternsByTaskType,
  upsertWorkflowPattern,
} from "./db.js";
import type { ContextArtifact, TurnRecord, WorkflowPattern } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WORKFLOW_PATTERN_EXPIRY_DAYS = 30;

/** Do not track "general" sessions — not enough signal. */
const UNTRACKED_TASK_TYPES = new Set(["general"]);

/** Maximum tool sequence length stored (prevent huge patterns). */
const MAX_TOOL_SEQUENCE_LENGTH = 20;

/** Maximum artifact types stored per pattern. */
const MAX_ARTIFACT_TYPES = 10;

// ---------------------------------------------------------------------------
// Pattern ID
// ---------------------------------------------------------------------------

/**
 * Derive a stable string ID from (taskType, toolSequence).
 * Uses a fast djb2-style hash so we avoid importing a crypto module.
 * The same task type + same ordered tool set always yields the same ID.
 */
export function hashPatternKey(taskType: string, toolSequence: string[]): string {
  const key = `${taskType}:${toolSequence.join(",")}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    // djb2: h = h * 33 ^ c
    h = ((h << 5) + h) ^ key.charCodeAt(i);
    h >>>= 0; // keep unsigned 32-bit
  }
  return `${taskType}-${h.toString(16)}`;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Build an ordered, globally-deduplicated tool sequence from all turn records.
 * Only successful tool calls are included (isError === false).
 * Each tool name appears at most once, in the order of first use across the
 * session. The result is capped at MAX_TOOL_SEQUENCE_LENGTH.
 */
export function extractToolSequence(turnRecords: TurnRecord[]): string[] {
  const seen = new Set<string>();
  const sequence: string[] = [];
  outer: for (const record of turnRecords) {
    for (const tc of record.toolCalls) {
      if (tc.isError) continue;
      if (!seen.has(tc.tool)) {
        seen.add(tc.tool);
        sequence.push(tc.tool);
        if (sequence.length >= MAX_TOOL_SEQUENCE_LENGTH) break outer;
      }
    }
  }
  return sequence;
}

/**
 * Extract artifact content types from the session's artifacts, sorted by
 * frequency (most common first). Capped at MAX_ARTIFACT_TYPES.
 */
export function extractArtifactTypes(artifacts: ContextArtifact[]): string[] {
  const freq: Record<string, number> = {};
  for (const a of artifacts) {
    freq[a.contentType] = (freq[a.contentType] ?? 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ARTIFACT_TYPES)
    .map(([type]) => type);
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Extract a WorkflowPattern from a completed session and persist it.
 *
 * Returns true if a pattern was extracted and persisted, false when:
 * - taskType is "general" (not enough signal)
 * - No successful tool calls were made in the session
 *
 * On upsert, hit_count increments if the same (taskType, toolSequence) was
 * seen before; otherwise a new row is inserted.
 */
export function persistSessionPattern(
  db: Database,
  taskType: string,
  turnRecords: TurnRecord[],
  artifacts: ContextArtifact[],
): boolean {
  if (UNTRACKED_TASK_TYPES.has(taskType)) return false;

  const toolSequence = extractToolSequence(turnRecords);
  if (toolSequence.length === 0) return false;

  const artifactTypes = extractArtifactTypes(artifacts);
  const now = Date.now();
  const id = hashPatternKey(taskType, toolSequence);

  upsertWorkflowPattern(db, {
    id,
    taskType,
    toolSequence,
    artifactTypes,
    hitCount: 1,
    lastSeen: now,
    createdAt: now,
  });
  return true;
}

/**
 * Remove patterns whose last_seen is older than WORKFLOW_PATTERN_EXPIRY_DAYS.
 * Returns the number of patterns deleted.
 */
export function pruneExpiredPatterns(db: Database): number {
  const cutoffMs =
    Date.now() - WORKFLOW_PATTERN_EXPIRY_DAYS * 24 * 60 * 60 * 1_000;
  return deleteExpiredWorkflowPatterns(db, cutoffMs);
}

/**
 * Query stored patterns for a task type, ordered by hitCount DESC.
 */
export function queryPatternsForTaskType(
  db: Database,
  taskType: string,
): WorkflowPattern[] {
  return listWorkflowPatternsByTaskType(db, taskType);
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/**
 * Render a compact "Workflow Context" section for injection into the prompt.
 * Returns an empty string when there are no meaningful patterns to show.
 *
 * The section surfaces the most-commonly-used tools and artifact types from
 * up to TOP_PATTERNS_TO_RENDER past sessions of the same task type, giving
 * the LLM a lightweight hint about what context has been useful before.
 */
const TOP_PATTERNS_TO_RENDER = 3;

export function renderWorkflowContext(
  patterns: WorkflowPattern[],
  taskType: string,
): string {
  if (patterns.length === 0) return "";

  const top = patterns.slice(0, TOP_PATTERNS_TO_RENDER);
  const totalHits = top.reduce((s, p) => s + p.hitCount, 0);

  // Aggregate tools and artifact types across top patterns (frequency-weighted).
  const toolWeight: Record<string, number> = {};
  const typeWeight: Record<string, number> = {};
  for (const p of top) {
    for (const t of p.toolSequence) {
      toolWeight[t] = (toolWeight[t] ?? 0) + p.hitCount;
    }
    for (const t of p.artifactTypes) {
      typeWeight[t] = (typeWeight[t] ?? 0) + p.hitCount;
    }
  }

  const topTools = Object.entries(toolWeight)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t]) => t);

  const topTypes = Object.entries(typeWeight)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);

  if (topTools.length === 0) return "";

  const sessionWord = totalHits === 1 ? "session" : "sessions";
  const lines = [
    `## Workflow Context`,
    ``,
    `Based on ${totalHits} past ${taskType} ${sessionWord}:`,
    `- Tools typically used: ${topTools.join(", ")}`,
  ];
  if (topTypes.length > 0) {
    lines.push(`- Artifact types typically relevant: ${topTypes.join(", ")}`);
  }

  return lines.join("\n");
}
