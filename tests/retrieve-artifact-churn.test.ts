import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextEngine } from "../src/context-engine/index.js";
import { createKnowledgeTools } from "../src/tools/knowledge.js";
import { buildArtifactCard } from "../src/context-engine/summarize.js";
import type { EventLog } from "../src/event-log.js";

function mockEventLog(): EventLog {
  return {
    append: mock(),
    search: mock().mockReturnValue([]),
    readLast: mock().mockReturnValue([]),
    close: mock(),
    eventCount: mock().mockReturnValue(0),
  } as unknown as EventLog;
}

const ENGINE_CONFIG = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 10,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
  pressure: { compact_at: 0.7, emergency_at: 0.85 },
};

describe("retrieve_artifact identical-retry churn (#294)", () => {
  let dbPath: string;
  let engine: ContextEngine;
  let scorecard: ScorecardTracker;
  let tools: ReturnType<typeof createKnowledgeTools>;
  let artifactId: string;

  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), "praana-retrieve-churn-")), "context.db");
    engine = ContextEngine.open(dbPath, "sess-retrieve-churn", ENGINE_CONFIG);
    scorecard = engine.scorecard;
    const ingested = engine.ingestToolResult({
      sourceTool: "read_file",
      command: "/proj/run.tsx",
      rawText: "export const run = () => {}\n".repeat(400),
      createdTurn: 1,
    });
    artifactId = ingested.artifactId!;
    tools = createKnowledgeTools({
      eventLog: mockEventLog(),
      memoryStore: null,
      memoryEnabled: false,
      incognito: false,
      contextEngine: engine,
      skillScorecard: scorecard,
      getCurrentTurn: () => 2,
    });
  });

  afterEach(() => {
    try {
      engine.close();
    } catch {
      // ignore
    }
    rmSync(dbPath, { force: true });
  });

  it("returns full content on first retrieve, card on identical retry", async () => {
    const first = await tools.retrieve_artifact.execute({ id: artifactId });
    expect(first.ok).toBe(true);
    expect(first.content).toContain("export const run");
    expect(first.warning).toBeUndefined();
    expect(scorecard.getCounters().artifactRetrievalRetries).toBe(0);

    const second = await tools.retrieve_artifact.execute({ id: artifactId });
    expect(second.ok).toBe(true);
    // Identical key → deterministic card, not full payload.
    const card = buildArtifactCard(
      artifactId,
      "read_file",
      "/proj/run.tsx",
      engine.getArtifact(artifactId)!.rawTokens,
    );
    expect(second.content).toBe(card);
    expect(second.skipped_payload).toBe(true);
    expect(second.original_turn).toBe(1);
    expect(second.warning).toMatch(/Already retrieved/);
    expect(scorecard.getCounters().artifactRetrievalRetries).toBe(1);

    // Total retrieve calls still counts retries honestly.
    expect(scorecard.getCounters().artifactRetrieveCalls).toBe(2);
  });

  it("different filters do not count as retries against each other", async () => {
    const a = await tools.retrieve_artifact.execute({
      id: artifactId,
      lineStart: 1,
      lineEnd: 10,
    });
    expect(a.ok).toBe(true);
    expect(a.content).toContain("export const run");

    const b = await tools.retrieve_artifact.execute({
      id: artifactId,
      lineStart: 11,
      lineEnd: 20,
    });
    expect(b.ok).toBe(true);
    expect(b.content).toContain("export const run");
    expect(scorecard.getCounters().artifactRetrievalRetries).toBe(0);
  });

  it("tracks path-level access for file-read artifacts across retrieves", async () => {
    // First retrieve (no params) — tracks path access, count=1, not duplicate.
    await tools.retrieve_artifact.execute({ id: artifactId });
    expect(scorecard.getCounters().duplicateFileAccess).toBe(0);

    // Second retrieve with different range — not short-circuited, tracks again.
    await tools.retrieve_artifact.execute({
      id: artifactId,
      lineStart: 1,
      lineEnd: 50,
    });
    expect(scorecard.getCounters().duplicateFileAccess).toBe(1);
  });
});
