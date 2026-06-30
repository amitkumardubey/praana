/**
 * Tests for workflow pattern tracking (issue #92).
 *
 * Covers: hash stability, tool sequence extraction, artifact type extraction,
 * session pattern persistence (upsert), expiry pruning, prompt rendering, and
 * DB CRUD round-trips on an in-memory SQLite database.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { openContextEngineDb } from "../src/context-engine/db.js";
import {
  hashPatternKey,
  extractToolSequence,
  extractArtifactTypes,
  persistSessionPattern,
  pruneExpiredPatterns,
  renderWorkflowContext,
  WORKFLOW_PATTERN_EXPIRY_DAYS,
} from "../src/context-engine/workflow-tracker.js";
import {
  upsertWorkflowPattern,
  listWorkflowPatterns,
  listWorkflowPatternsByTaskType,
  deleteExpiredWorkflowPatterns,
} from "../src/context-engine/db.js";
import type { ContextArtifact, TurnRecord, WorkflowPattern } from "../src/context-engine/types.js";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDb(): Database {
  return openContextEngineDb(":memory:");
}

function makeToolCall(
  tool: string,
  isError = false,
): TurnRecord["toolCalls"][number] {
  return { tool, args: {}, isError };
}

function makeTurnRecord(
  turn: number,
  toolNames: string[],
  isError = false,
): TurnRecord {
  return {
    turn,
    userMessage: `turn ${turn}`,
    assistantMessage: "ok",
    toolCalls: toolNames.map((t) => makeToolCall(t, isError)),
    artifactIds: [],
    filesRead: [],
    filesWritten: [],
    errors: [],
    tokenCount: 100,
    timestamp: Date.now(),
  };
}

function makeArtifact(contentType: ContextArtifact["contentType"]): ContextArtifact {
  return {
    id: `art-${contentType}-${Math.random().toString(36).slice(2)}`,
    sha256: "abc",
    sessionId: "sess-1",
    sourceTool: "shell",
    createdTurn: 1,
    rawTokens: 50,
    rawText: "content",
    summary: "summary",
    contentType,
    lastAccessedTurn: 1,
    accessCount: 1,
  };
}

function makePattern(overrides: Partial<WorkflowPattern> = {}): WorkflowPattern {
  return {
    id: "test-abc123",
    taskType: "testing",
    toolSequence: ["read_file", "shell"],
    artifactTypes: ["test_output"],
    hitCount: 1,
    lastSeen: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hashPatternKey
// ---------------------------------------------------------------------------

describe("hashPatternKey", () => {
  it("returns a non-empty string prefixed with taskType", () => {
    const id = hashPatternKey("testing", ["read_file", "shell"]);
    expect(id).toStartWith("testing-");
    expect(id.length).toBeGreaterThan(8);
  });

  it("produces the same ID for identical inputs", () => {
    const a = hashPatternKey("debugging", ["shell", "read_file"]);
    const b = hashPatternKey("debugging", ["shell", "read_file"]);
    expect(a).toBe(b);
  });

  it("produces different IDs for different task types", () => {
    const a = hashPatternKey("testing", ["shell"]);
    const b = hashPatternKey("debugging", ["shell"]);
    expect(a).not.toBe(b);
  });

  it("produces different IDs for different tool sequences", () => {
    const a = hashPatternKey("testing", ["read_file", "shell"]);
    const b = hashPatternKey("testing", ["shell", "write_file"]);
    expect(a).not.toBe(b);
  });

  it("produces different IDs for different ordering of tools", () => {
    const a = hashPatternKey("testing", ["read_file", "shell"]);
    const b = hashPatternKey("testing", ["shell", "read_file"]);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// extractToolSequence
// ---------------------------------------------------------------------------

describe("extractToolSequence", () => {
  it("returns empty array for no turn records", () => {
    expect(extractToolSequence([])).toEqual([]);
  });

  it("returns empty array when all tool calls are errors", () => {
    const records = [makeTurnRecord(1, ["read_file", "shell"], true)];
    expect(extractToolSequence(records)).toEqual([]);
  });

  it("extracts tools in order of first use across turns", () => {
    const records = [
      makeTurnRecord(1, ["read_file", "shell"]),
      makeTurnRecord(2, ["write_file", "shell"]),
    ];
    expect(extractToolSequence(records)).toEqual(["read_file", "shell", "write_file"]);
  });

  it("collapses adjacent duplicate tools (global dedup)", () => {
    const records = [
      {
        ...makeTurnRecord(1, []),
        toolCalls: [
          makeToolCall("read_file"),
          makeToolCall("read_file"), // duplicate → only first occurrence kept
          makeToolCall("shell"),
        ],
      },
    ];
    expect(extractToolSequence(records)).toEqual(["read_file", "shell"]);
  });

  it("does NOT re-add tools seen earlier in the session", () => {
    const records = [
      {
        ...makeTurnRecord(1, []),
        toolCalls: [
          makeToolCall("read_file"),
          makeToolCall("shell"),
          makeToolCall("read_file"), // already seen → skipped
        ],
      },
    ];
    expect(extractToolSequence(records)).toEqual(["read_file", "shell"]);
  });

  it("skips error tool calls but keeps successful ones", () => {
    const records = [
      {
        ...makeTurnRecord(1, []),
        toolCalls: [
          makeToolCall("read_file", false),
          makeToolCall("shell", true),  // error → skipped
          makeToolCall("write_file", false),
        ],
      },
    ];
    expect(extractToolSequence(records)).toEqual(["read_file", "write_file"]);
  });
});

// ---------------------------------------------------------------------------
// extractArtifactTypes
// ---------------------------------------------------------------------------

describe("extractArtifactTypes", () => {
  it("returns empty array for no artifacts", () => {
    expect(extractArtifactTypes([])).toEqual([]);
  });

  it("returns single type for single artifact", () => {
    expect(extractArtifactTypes([makeArtifact("test_output")])).toEqual(["test_output"]);
  });

  it("sorts by frequency, most common first", () => {
    const artifacts = [
      makeArtifact("test_output"),
      makeArtifact("test_output"),
      makeArtifact("build_output"),
      makeArtifact("diff"),
    ];
    const result = extractArtifactTypes(artifacts);
    expect(result[0]).toBe("test_output");
    expect(result).toContain("build_output");
    expect(result).toContain("diff");
  });

  it("deduplicates types", () => {
    const artifacts = [
      makeArtifact("code"),
      makeArtifact("code"),
      makeArtifact("code"),
    ];
    expect(extractArtifactTypes(artifacts)).toEqual(["code"]);
  });
});

// ---------------------------------------------------------------------------
// persistSessionPattern
// ---------------------------------------------------------------------------

describe("persistSessionPattern", () => {
  it("returns null for 'general' task type", () => {
    const db = openDb();
    const records = [makeTurnRecord(1, ["read_file"])];
    const result = persistSessionPattern(db, "general", records, []);
    expect(result).toBeNull();
  });

  it("returns null when no successful tool calls exist", () => {
    const db = openDb();
    const records = [makeTurnRecord(1, ["read_file"], true)]; // all errors
    const result = persistSessionPattern(db, "testing", records, []);
    expect(result).toBeNull();
  });

  it("returns null for empty turn records", () => {
    const db = openDb();
    const result = persistSessionPattern(db, "testing", [], []);
    expect(result).toBeNull();
  });

  it("inserts a pattern and returns it", () => {
    const db = openDb();
    const records = [makeTurnRecord(1, ["read_file", "shell"])];
    const artifacts = [makeArtifact("test_output")];
    const pattern = persistSessionPattern(db, "testing", records, artifacts);

    expect(pattern).not.toBeNull();
    expect(pattern!.taskType).toBe("testing");
    expect(pattern!.toolSequence).toEqual(["read_file", "shell"]);
    expect(pattern!.artifactTypes).toEqual(["test_output"]);
    expect(pattern!.hitCount).toBe(1);
  });

  it("increments hitCount on repeated upsert with same pattern", () => {
    const db = openDb();
    const records = [makeTurnRecord(1, ["read_file", "shell"])];
    const artifacts = [makeArtifact("test_output")];

    persistSessionPattern(db, "testing", records, artifacts);
    persistSessionPattern(db, "testing", records, artifacts);
    persistSessionPattern(db, "testing", records, artifacts);

    const stored = listWorkflowPatternsByTaskType(db, "testing");
    expect(stored).toHaveLength(1);
    expect(stored[0].hitCount).toBe(3);
  });

  it("creates separate patterns for different task types", () => {
    const db = openDb();
    const records = [makeTurnRecord(1, ["read_file"])];

    persistSessionPattern(db, "testing", records, []);
    persistSessionPattern(db, "debugging", records, []);

    const all = listWorkflowPatterns(db);
    expect(all).toHaveLength(2);
    const types = all.map((p) => p.taskType);
    expect(types).toContain("testing");
    expect(types).toContain("debugging");
  });

  it("creates separate patterns for different tool sequences under the same task type", () => {
    const db = openDb();
    const records1 = [makeTurnRecord(1, ["read_file", "shell"])];
    const records2 = [makeTurnRecord(1, ["shell", "write_file"])];

    persistSessionPattern(db, "testing", records1, []);
    persistSessionPattern(db, "testing", records2, []);

    const stored = listWorkflowPatternsByTaskType(db, "testing");
    expect(stored).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// pruneExpiredPatterns
// ---------------------------------------------------------------------------

describe("pruneExpiredPatterns", () => {
  it("returns 0 when no patterns are expired", () => {
    const db = openDb();
    upsertWorkflowPattern(db, makePattern({ lastSeen: Date.now() }));
    const deleted = pruneExpiredPatterns(db);
    expect(deleted).toBe(0);
  });

  it("deletes patterns older than WORKFLOW_PATTERN_EXPIRY_DAYS", () => {
    const db = openDb();
    const oldMs =
      Date.now() - (WORKFLOW_PATTERN_EXPIRY_DAYS + 1) * 24 * 60 * 60 * 1_000;
    upsertWorkflowPattern(db, makePattern({ id: "old-1", lastSeen: oldMs }));
    upsertWorkflowPattern(db, makePattern({ id: "new-1", lastSeen: Date.now() }));

    const deleted = pruneExpiredPatterns(db);
    expect(deleted).toBe(1);

    const remaining = listWorkflowPatterns(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("new-1");
  });

  it("deletes all patterns when all are expired", () => {
    const db = openDb();
    const oldMs = Date.now() - (WORKFLOW_PATTERN_EXPIRY_DAYS + 5) * 24 * 60 * 60 * 1_000;
    upsertWorkflowPattern(db, makePattern({ id: "old-a", lastSeen: oldMs }));
    upsertWorkflowPattern(db, makePattern({ id: "old-b", lastSeen: oldMs }));

    const deleted = pruneExpiredPatterns(db);
    expect(deleted).toBe(2);
    expect(listWorkflowPatterns(db)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deleteExpiredWorkflowPatterns (DB function directly)
// ---------------------------------------------------------------------------

describe("deleteExpiredWorkflowPatterns", () => {
  it("deletes rows with last_seen < beforeMs", () => {
    const db = openDb();
    const now = Date.now();
    upsertWorkflowPattern(db, makePattern({ id: "p1", lastSeen: now - 1000 }));
    upsertWorkflowPattern(db, makePattern({ id: "p2", lastSeen: now + 1000 }));

    const deleted = deleteExpiredWorkflowPatterns(db, now);
    expect(deleted).toBe(1);
    expect(listWorkflowPatterns(db)[0].id).toBe("p2");
  });
});

// ---------------------------------------------------------------------------
// upsertWorkflowPattern / listWorkflowPatterns / listWorkflowPatternsByTaskType
// ---------------------------------------------------------------------------

describe("DB CRUD", () => {
  it("inserts and retrieves a pattern", () => {
    const db = openDb();
    const now = Date.now();
    const p = makePattern({ lastSeen: now, createdAt: now });
    upsertWorkflowPattern(db, p);

    const all = listWorkflowPatterns(db);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(p.id);
    expect(all[0].taskType).toBe("testing");
    expect(all[0].toolSequence).toEqual(["read_file", "shell"]);
    expect(all[0].artifactTypes).toEqual(["test_output"]);
    expect(all[0].hitCount).toBe(1);
  });

  it("upsert increments hit_count and updates last_seen", () => {
    const db = openDb();
    const earlier = Date.now() - 5000;
    const later = Date.now();
    upsertWorkflowPattern(db, makePattern({ lastSeen: earlier }));
    upsertWorkflowPattern(db, makePattern({ lastSeen: later }));

    const all = listWorkflowPatterns(db);
    expect(all).toHaveLength(1);
    expect(all[0].hitCount).toBe(2);
    expect(all[0].lastSeen).toBe(later);
  });

  it("listWorkflowPatternsByTaskType filters correctly", () => {
    const db = openDb();
    upsertWorkflowPattern(db, makePattern({ id: "t1", taskType: "testing" }));
    upsertWorkflowPattern(db, makePattern({ id: "d1", taskType: "debugging" }));
    upsertWorkflowPattern(db, makePattern({ id: "t2", taskType: "testing" }));

    const testing = listWorkflowPatternsByTaskType(db, "testing");
    expect(testing).toHaveLength(2);
    expect(testing.every((p) => p.taskType === "testing")).toBe(true);

    const debugging = listWorkflowPatternsByTaskType(db, "debugging");
    expect(debugging).toHaveLength(1);
    expect(debugging[0].id).toBe("d1");
  });

  it("listWorkflowPatterns returns patterns sorted by hitCount DESC", () => {
    const db = openDb();
    upsertWorkflowPattern(db, makePattern({ id: "low", taskType: "testing", hitCount: 1 }));
    // upsert same pattern twice to get hitCount=2
    const highPattern = makePattern({ id: "high", taskType: "debugging", hitCount: 1 });
    upsertWorkflowPattern(db, highPattern);
    upsertWorkflowPattern(db, highPattern); // hitCount → 2

    const all = listWorkflowPatterns(db);
    expect(all[0].hitCount).toBeGreaterThanOrEqual(all[1].hitCount);
  });
});

// ---------------------------------------------------------------------------
// renderWorkflowContext
// ---------------------------------------------------------------------------

describe("renderWorkflowContext", () => {
  it("returns empty string for empty patterns", () => {
    expect(renderWorkflowContext([], "testing")).toBe("");
  });

  it("includes taskType in the rendered section", () => {
    const patterns = [makePattern()];
    const rendered = renderWorkflowContext(patterns, "testing");
    expect(rendered).toContain("testing");
    expect(rendered).toContain("## Workflow Context");
  });

  it("lists tool names from patterns", () => {
    const patterns = [
      makePattern({ toolSequence: ["read_file", "shell", "write_file"] }),
    ];
    const rendered = renderWorkflowContext(patterns, "testing");
    expect(rendered).toContain("read_file");
    expect(rendered).toContain("shell");
    expect(rendered).toContain("write_file");
  });

  it("includes artifact types when present", () => {
    const patterns = [makePattern({ artifactTypes: ["test_output", "build_output"] })];
    const rendered = renderWorkflowContext(patterns, "testing");
    expect(rendered).toContain("test_output");
    expect(rendered).toContain("build_output");
  });

  it("shows total hit count across top patterns", () => {
    const patterns = [
      makePattern({ id: "a", hitCount: 3 }),
      makePattern({ id: "b", hitCount: 2, toolSequence: ["shell"] }),
    ];
    const rendered = renderWorkflowContext(patterns, "testing");
    expect(rendered).toContain("5"); // 3 + 2 = 5 sessions
  });

  it("uses singular 'session' when hitCount is 1", () => {
    const patterns = [makePattern({ hitCount: 1 })];
    const rendered = renderWorkflowContext(patterns, "testing");
    expect(rendered).toMatch(/1 past testing session\b/);
  });

  it("uses plural 'sessions' when hitCount > 1", () => {
    const patterns = [makePattern({ hitCount: 5 })];
    const rendered = renderWorkflowContext(patterns, "testing");
    expect(rendered).toMatch(/5 past testing sessions/);
  });

  it("aggregates tools across multiple patterns", () => {
    const patterns = [
      makePattern({ id: "a", toolSequence: ["read_file"], artifactTypes: [], hitCount: 1 }),
      makePattern({ id: "b", toolSequence: ["shell"], artifactTypes: [], hitCount: 1 }),
    ];
    const rendered = renderWorkflowContext(patterns, "testing");
    expect(rendered).toContain("read_file");
    expect(rendered).toContain("shell");
  });

  it("returns empty string when all patterns have empty tool sequences", () => {
    const patterns = [makePattern({ toolSequence: [] })];
    const rendered = renderWorkflowContext(patterns, "testing");
    expect(rendered).toBe("");
  });
});
