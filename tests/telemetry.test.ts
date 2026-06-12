import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextEngine } from "../src/context-engine/index.js";
import { insertDistillerStat } from "../src/context-engine/db.js";
import { renderSessionTelemetrySummary } from "../src/context-engine/telemetry.js";
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

describe("context engine telemetry", () => {
  let dbPath: string;
  let engine: ContextEngine;

  afterEach(() => {
    engine?.close();
    rmSync(dbPath, { force: true });
  });

  function openEngine(): ContextEngine {
    dbPath = join(mkdtempSync(join(tmpdir(), "aria-telemetry-")), "memory.db");
    return ContextEngine.open(dbPath, "sess-telemetry", TEST_CONFIG);
  }

  it("records artifact retrieval and compile pressure events", () => {
    engine = openEngine();
    const raw = "x".repeat(400);
    const ingested = engine.ingestToolResult({
      sourceTool: "shell",
      command: "npm test",
      rawText: raw,
      createdTurn: 0,
    });
    expect(ingested.artifactId).toBeDefined();

    const retrieved = engine.retrieveArtifact(ingested.artifactId!, 2);
    expect(retrieved.ok).toBe(true);

    engine.recordCompileTelemetry({
      turn: 1,
      pressureMode: "compact",
      excludedScoredUnits: 2,
    });
    engine.recordCompileTelemetry({
      turn: 2,
      pressureMode: "compact",
      excludedScoredUnits: 0,
    });

    const summary = engine.finalizeTelemetry(3);
    expect(summary.stats.artifactRetrievals).toBe(1);
    expect(summary.stats.pressureEvents).toBe(1);
    expect(summary.stats.compactionTriggers).toBe(1);
    expect(summary.artifactsProduced).toBe(1);
    expect(summary.retrievalRate).toBe(1);
  });

  it("aggregates distiller savings and renders a session summary", () => {
    engine = openEngine();
    insertDistillerStat(engine.store.getDb(), {
      sessionId: "sess-telemetry",
      tool: "shell",
      contentType: "text",
      distiller: "generic",
      inputTokens: 1000,
      outputTokens: 200,
      savingsPct: 80,
      execTimeMs: 5,
      turn: 0,
    });

    const summary = engine.finalizeTelemetry(2);
    expect(summary.stats.totalDistillerSavings).toBe(800);
    expect(summary.distillerRanking[0]?.distiller).toBe("generic");

    const text = renderSessionTelemetrySummary(summary);
    expect(text).toContain("distiller token savings: 800");
    expect(text).toContain("retrieval rate");
  });
});
