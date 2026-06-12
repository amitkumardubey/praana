import type Database from "better-sqlite3";
import type { PressureMode } from "./types.js";
import {
  countSessionArtifacts,
  finalizeSessionStats,
  incrementSessionStat,
  insertArtifactAccess,
  listDistillerCostRanking,
  type ArtifactAccessType,
  type DistillerCostRow,
  type SessionStatsRow,
} from "./db.js";

export interface CompileTelemetryInput {
  turn: number;
  pressureMode: PressureMode;
  excludedScoredUnits: number;
}

export interface SessionTelemetrySummary {
  stats: SessionStatsRow;
  artifactsProduced: number;
  retrievalRate: number;
  distillerRanking: DistillerCostRow[];
}

export class TelemetryRecorder {
  private lastPressureMode: PressureMode = "normal";
  private readonly contextEngineEnabled: boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly sessionId: string,
    contextEngineEnabled = true,
  ) {
    this.contextEngineEnabled = contextEngineEnabled;
  }

  recordArtifactAccess(
    artifactId: string,
    accessType: ArtifactAccessType,
    turn: number,
  ): void {
    insertArtifactAccess(this.db, this.sessionId, artifactId, accessType, turn);
    if (accessType === "retrieved") {
      incrementSessionStat(this.db, this.sessionId, "artifact_retrievals", 1, this.contextEngineEnabled);
    }
  }

  recordCompileTelemetry(input: CompileTelemetryInput): void {
    if (input.pressureMode !== "normal" && this.lastPressureMode === "normal") {
      incrementSessionStat(this.db, this.sessionId, "pressure_events", 1, this.contextEngineEnabled);
    }
    if (input.pressureMode === "emergency" && this.lastPressureMode === "compact") {
      incrementSessionStat(this.db, this.sessionId, "pressure_events", 1, this.contextEngineEnabled);
    }
    this.lastPressureMode = input.pressureMode;

    if (input.excludedScoredUnits > 0) {
      incrementSessionStat(this.db, this.sessionId, "compaction_triggers", 1, this.contextEngineEnabled);
    }
  }

  finalize(totalTurns: number): SessionTelemetrySummary {
    const stats = finalizeSessionStats(this.db, this.sessionId, totalTurns, this.contextEngineEnabled);
    const artifactsProduced = countSessionArtifacts(this.db, this.sessionId);
    const retrievalRate =
      artifactsProduced > 0 ? stats.artifactRetrievals / artifactsProduced : 0;
    const distillerRanking = listDistillerCostRanking(this.db, this.sessionId);

    return {
      stats,
      artifactsProduced,
      retrievalRate,
      distillerRanking,
    };
  }
}

export function renderSessionTelemetrySummary(summary: SessionTelemetrySummary): string {
  const { stats, artifactsProduced, retrievalRate, distillerRanking } = summary;
  const lines = [
    "Context engine telemetry:",
    `  turns: ${stats.totalTurns}`,
    `  artifacts produced: ${artifactsProduced}`,
    `  artifact retrievals: ${stats.artifactRetrievals} (${(retrievalRate * 100).toFixed(1)}% retrieval rate)`,
    `  distiller token savings: ${Math.round(stats.totalDistillerSavings)}`,
    `  pressure events: ${stats.pressureEvents}`,
    `  compaction triggers: ${stats.compactionTriggers}`,
  ];

  if (distillerRanking.length > 0) {
    lines.push("  distiller cost ranking (top 3):");
    for (const row of distillerRanking.slice(0, 3)) {
      lines.push(
        `    - ${row.distiller}/${row.tool}: ${row.runs} runs, ~${row.estimatedCost} residual tokens, ${row.avgSavingsPct}% avg savings`,
      );
    }
  }

  if (retrievalRate > 0.25) {
    lines.push("  note: retrieval rate >25% — distillers may be too aggressive for some commands");
  }

  return lines.join("\n");
}
