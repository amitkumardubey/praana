import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateGraph } from "../src/state-graph.js";
import {
  buildEventLineage,
  ContextEngine,
} from "../src/context-engine/index.js";
import { TurnRecorder } from "../src/context-engine/turn-recorder.js";
import { getArtifactById } from "../src/context-engine/db.js";
import type { ContextEngineConfig } from "../src/types.js";

const TEST_CONFIG: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 50,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
  pressure: { compact_at: 0.7, emergency_at: 0.85 },
};

describe("event lineage", () => {
  let dbPath: string;
  let engine: ContextEngine;

  afterEach(() => {
    engine?.close();
    rmSync(dbPath, { force: true });
  });

  function openEngine(): ContextEngine {
    dbPath = join(mkdtempSync(join(tmpdir(), "praana-lineage-")), "memory.db");
    return ContextEngine.open(dbPath, "sess-lineage", TEST_CONFIG);
  }

  it("builds lineage from turn record and digest metadata", () => {
    engine = openEngine();
    const raw = "x".repeat(400);
    const ingested = engine.ingestToolResult({
      sourceTool: "read_file",
      command: "src/auth.ts",
      rawText: raw,
      createdTurn: 1,
    });

    const recorder = new TurnRecorder("implement auth");
    recorder.recordToolCall({
      tool: "read_file",
      args: { path: "src/auth.ts" },
      result: { ok: true, content: raw },
      isError: false,
      artifactId: ingested.artifactId,
    });
    const record = recorder.toRecord("read auth module", 1, 2000);
    engine.appendTurn(record);

    const stateGraph = new StateGraph();
    stateGraph.create("decision", {
      summary: "use JWT",
      rationale: "stateless auth",
    });
    engine.processTurnExtraction({
      userMessage: "implement auth",
      record,
      stateBefore: engine.captureStateSnapshot(stateGraph),
      stateGraph,
    });

    const result = engine.eventLineage(ingested.artifactId!, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lineage.producedTurn).toBe(1);
    expect(result.lineage.producedBy).toContain("read_file");
    expect(result.lineage.producedBy).toContain("src/auth.ts");
    expect(result.lineage.relatedFiles).toContain("src/auth.ts");
    expect(result.text).toContain(ingested.artifactId!);

    const artifact = getArtifactById(engine.store.getDb(), ingested.artifactId!);
    expect(artifact?.lastAccessedTurn).toBe(5);
    expect(artifact?.accessCount).toBeGreaterThan(0);
  });

  it("touches matched artifacts during turn ledger search", () => {
    engine = openEngine();
    const raw = `authentication middleware failure\n${"x".repeat(400)}`;
    const ingested = engine.ingestToolResult({
      sourceTool: "shell",
      command: "npm test",
      rawText: raw,
      createdTurn: 0,
    });
    expect(ingested.artifactId).toBeDefined();

    const recorder = new TurnRecorder("fix auth tests");
    recorder.recordToolCall({
      tool: "shell",
      args: { command: "npm test" },
      result: { ok: false, stderr: raw },
      isError: true,
      artifactId: ingested.artifactId,
    });
    engine.appendTurn(recorder.toRecord("tests failed", 0, 1000));

    const matches = engine.searchTurnEvents("auth tests", 10, 3);
    expect(matches.length).toBeGreaterThan(0);

    const artifact = getArtifactById(engine.store.getDb(), ingested.artifactId!);
    expect(artifact?.lastAccessedTurn).toBe(3);
  });

  it("returns not found for unknown artifact ids", () => {
    engine = openEngine();
    const result = engine.eventLineage("art_missing", 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not found");
  });

  it("buildEventLineage links same-turn artifacts", () => {
    const artifact = {
      id: "art_a",
      sessionId: "sess",
      sourceTool: "shell",
      command: "npm test",
      contentType: "text" as const,
      createdTurn: 2,
      lastAccessedTurn: 2,
      accessCount: 0,
      sha256: "abc",
      rawSize: 100,
      summary: "test output",
      createdAt: 1,
    };
    const sibling = {
      ...artifact,
      id: "art_b",
      command: "npm run lint",
      sha256: "def",
    };

    const lineage = buildEventLineage({
      artifact,
      turnRecord: {
        turn: 2,
        userMessage: "fix tests",
        assistantMessage: "running checks",
        toolCalls: [
          {
            tool: "shell",
            args: { command: "npm test" },
            resultArtifactId: "art_a",
            isError: false,
          },
        ],
        artifactIds: ["art_a", "art_b"],
        filesRead: [],
        filesWritten: [],
        errors: [],
        timestamp: 1,
      },
      turnDigest: null,
      checkpoint: null,
      sessionArtifacts: [artifact, sibling],
      turnRecords: [],
    });

    expect(lineage.relatedArtifacts.map((ref) => ref.id)).toContain("art_b");
    expect(lineage.producedBy).toBe('shell command "npm test" in turn 2');
  });
});
