import type Database from "better-sqlite3";
import DatabaseConstructor from "better-sqlite3";
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
  skillsLoaded: number;
  skillReloadCount: number;
  skillTokensConsumed: number;
  decisionContradictions: number;
}

export class TelemetryRecorder {
  private lastPressureMode: PressureMode = "normal";
  private readonly contextEngineEnabled: boolean;
  private skillsLoaded = 0;
  private skillReloadCount = 0;
  private skillTokensConsumed = 0;
  private decisionContradictions = 0;

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

  recordSkillLoad(skillId: string, isReload: boolean, tokens?: number): void {
    this.skillsLoaded++;
    if (isReload) {
      this.skillReloadCount++;
    }
    if (tokens) {
      this.skillTokensConsumed += tokens;
    }
  }

  recordDecisionContradiction(): void {
    this.decisionContradictions++;
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
      skillsLoaded: this.skillsLoaded,
      skillReloadCount: this.skillReloadCount,
      skillTokensConsumed: this.skillTokensConsumed,
      decisionContradictions: this.decisionContradictions,
    };
  }
}

// ============================================================
// ScorecardTracker — per-session telemetry counter (issue #99)
// ============================================================

export interface ScorecardCounters {
  artifactRetrieveCalls: number;
  artifactCardsProduced: number;
  repeatFileReads: number;
  decisionContradictions: number;
  turnEventSearches: number;
  totalTurns: number;
  pressureEvents: number;
  compactionTriggers: number;
  recallCalls: number;
  skillsLoaded: number;
  skillsUsed: number;
  skillUnderloadEvents: number;
  skillReloadCount: number;
  skillTokensConsumed: number;
}

/**
 * In-memory counter tracker that flushes one row to the scorecard table
 * at session end. Created only when measurement_mode or context_engine is
 * enabled. When both are false, callers get a no-op null object so no guards
 * are needed at call sites.
 */
export class ScorecardTracker {
  private counters: ScorecardCounters = {
    artifactRetrieveCalls: 0,
    artifactCardsProduced: 0,
    repeatFileReads: 0,
    decisionContradictions: 0,
    turnEventSearches: 0,
    totalTurns: 0,
    pressureEvents: 0,
    compactionTriggers: 0,
    recallCalls: 0,
    skillsLoaded: 0,
    skillsUsed: 0,
    skillUnderloadEvents: 0,
    skillReloadCount: 0,
    skillTokensConsumed: 0,
  };
  private validityAvgStart = 0;
  private usefulnessAvgStart = 0;
  private validityAvgEnd = 0;
  private usefulnessAvgEnd = 0;
  private recallUsedCount = 0;

  constructor(
    private readonly db: Database.Database | null,
    private readonly sessionId: string,
    private readonly engineOn: boolean,
  ) {}

  /** Increment a counter field. No-op when db is null (null-object pattern). */
  inc(field: string, by = 1): void {
    if (!this.db) return; // null-object: no-op
    const key = field as keyof ScorecardCounters;
    if (key in this.counters) {
      this.counters[key] = (this.counters[key] ?? 0) + by;
    }
  }

  /** Set skillsUsed directly (computed from reference count at session end). */
  setSkillsUsed(count: number): void {
    if (!this.db) return;
    this.counters.skillsUsed = count;
  }

  /** Set skillUnderloadEvents directly. */
  setSkillUnderloadEvents(count: number): void {
    if (!this.db) return;
    this.counters.skillUnderloadEvents = count;
  }

  /**
   * Query memory signal averages from the memory DB. Opens a temporary
   * read-only connection if a memoryDbPath is provided.
   */
  private getMemoryAverages(memoryDbPath?: string): { validityAvg: number; usefulnessAvg: number } {
    if (!memoryDbPath) return { validityAvg: 0, usefulnessAvg: 0 };
    try {
      const memDb = new DatabaseConstructor(memoryDbPath, { readonly: true });
      try {
        const row = memDb
          .prepare("SELECT AVG(validity) as v, AVG(usefulness) as u FROM entries WHERE retracted IS NOT 1")
          .get() as { v: number | null; u: number | null } | undefined;
        return {
          validityAvg: row?.v ?? 0,
          usefulnessAvg: row?.u ?? 0,
        };
      } finally {
        memDb.close();
      }
    } catch {
      return { validityAvg: 0, usefulnessAvg: 0 };
    }
  }

  /**
   * Call at session start — snaps memory averages.
   * Optionally pass the memory db path to query averages.
   */
  async recordMemoryStart(memoryDbPath?: string): Promise<void> {
    if (!this.db) return; // null-object: no-op
    const avgs = this.getMemoryAverages(memoryDbPath);
    this.validityAvgStart = avgs.validityAvg;
    this.usefulnessAvgStart = avgs.usefulnessAvg;
  }

  /**
   * Call at session end — snapshots memory end-state and writes the scorecard row.
   * @param memoryDbPath Path to the memory DB for end-state averages.
   * @param recallUsedCount Number of recalled entries marked as 'used' in this session.
   */
  async flush(memoryDbPath?: string, recallUsedCount = 0): Promise<void> {
    if (!this.db) return; // null-object: no-op

    const endAvgs = this.getMemoryAverages(memoryDbPath);
    this.validityAvgEnd = endAvgs.validityAvg;
    this.usefulnessAvgEnd = endAvgs.usefulnessAvg;
    this.recallUsedCount = recallUsedCount;

    this.db.prepare(
      `INSERT OR REPLACE INTO scorecard (
        session_id, context_engine_on, created_at,
        artifact_retrieve_calls, artifact_cards_produced, repeat_file_reads,
        decision_contradictions, turn_event_searches, total_turns,
        pressure_events, compaction_triggers,
        recall_calls, recall_used_count,
        validity_avg_start, validity_avg_end,
        usefulness_avg_start, usefulness_avg_end,
        skills_loaded, skills_used, skill_underload_events,
        skill_reload_count, skill_tokens_consumed
      ) VALUES (
        @sessionId, @engineOn, @createdAt,
        @artifactRetrieveCalls, @artifactCardsProduced, @repeatFileReads,
        @decisionContradictions, @turnEventSearches, @totalTurns,
        @pressureEvents, @compactionTriggers,
        @recallCalls, @recallUsedCount,
        @validityAvgStart, @validityAvgEnd,
        @usefulnessAvgStart, @usefulnessAvgEnd,
        @skillsLoaded, @skillsUsed, @skillUnderloadEvents,
        @skillReloadCount, @skillTokensConsumed
      )`
    ).run({
      sessionId: this.sessionId,
      engineOn: this.engineOn ? 1 : 0,
      createdAt: Date.now(),
      artifactRetrieveCalls: this.counters.artifactRetrieveCalls,
      artifactCardsProduced: this.counters.artifactCardsProduced,
      repeatFileReads: this.counters.repeatFileReads,
      decisionContradictions: this.counters.decisionContradictions,
      turnEventSearches: this.counters.turnEventSearches,
      totalTurns: this.counters.totalTurns,
      pressureEvents: this.counters.pressureEvents,
      compactionTriggers: this.counters.compactionTriggers,
      recallCalls: this.counters.recallCalls,
      recallUsedCount: this.recallUsedCount,
      validityAvgStart: this.validityAvgStart,
      validityAvgEnd: this.validityAvgEnd,
      usefulnessAvgStart: this.usefulnessAvgStart,
      usefulnessAvgEnd: this.usefulnessAvgEnd,
      skillsLoaded: this.counters.skillsLoaded,
      skillsUsed: this.counters.skillsUsed,
      skillUnderloadEvents: this.counters.skillUnderloadEvents,
      skillReloadCount: this.counters.skillReloadCount,
      skillTokensConsumed: this.counters.skillTokensConsumed,
    });
  }

  /** Return current counters for /stats display. */
  getCounters(): ScorecardCounters {
    return { ...this.counters };
  }
}

/** Create a no-op ScorecardTracker when neither measurement_mode nor engine is enabled. */
export function createNullScorecard(): ScorecardTracker {
  return new ScorecardTracker(null, "", false);
}

export function renderSessionTelemetrySummary(summary: SessionTelemetrySummary): string {
  const { stats, artifactsProduced, retrievalRate, distillerRanking, skillsLoaded, skillReloadCount, skillTokensConsumed, decisionContradictions } = summary;
  const lines = [
    "Context engine telemetry:",
    `  turns: ${stats.totalTurns}`,
    `  artifacts produced: ${artifactsProduced}`,
    `  artifact retrievals: ${stats.artifactRetrievals} (${(retrievalRate * 100).toFixed(1)}% retrieval rate)`,
    `  distiller token savings: ${Math.round(stats.totalDistillerSavings)}`,
    `  pressure events: ${stats.pressureEvents}`,
    `  compaction triggers: ${stats.compactionTriggers}`,
    `  skills loaded: ${skillsLoaded}, reloaded: ${skillReloadCount}, tokens: ~${skillTokensConsumed}`,
    `  decision contradictions: ${decisionContradictions}`,
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
