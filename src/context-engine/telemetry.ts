import type Database from "better-sqlite3";
import DatabaseConstructor from "better-sqlite3";
import type { PressureMode } from "./types.js";
import { getMemorySignalAverages } from "../memory/db.js";
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
  /** TODO(M7): semantic flip detection — column kept at 0 until M7 lands. */
  decisionContradictions: number;
}

export class TelemetryRecorder {
  private lastPressureMode: PressureMode = "normal";
  private readonly contextEngineEnabled: boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly sessionId: string,
    contextEngineEnabled = true,
    private readonly scorecard?: Pick<ScorecardTracker, "inc">,
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
      this.scorecard?.inc("pressureEvents");
    }
    if (input.pressureMode === "emergency" && this.lastPressureMode === "compact") {
      incrementSessionStat(this.db, this.sessionId, "pressure_events", 1, this.contextEngineEnabled);
      this.scorecard?.inc("pressureEvents");
    }
    this.lastPressureMode = input.pressureMode;

    if (input.excludedScoredUnits > 0) {
      incrementSessionStat(this.db, this.sessionId, "compaction_triggers", 1, this.contextEngineEnabled);
      this.scorecard?.inc("compactionTriggers");
    }
  }

  finalize(
    totalTurns: number,
    scorecardSnapshot?: Pick<
      ScorecardCounters,
      "skillsLoaded" | "skillReloadCount" | "skillTokensConsumed" | "decisionContradictions"
    >,
  ): SessionTelemetrySummary {
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
      skillsLoaded: scorecardSnapshot?.skillsLoaded ?? 0,
      skillReloadCount: scorecardSnapshot?.skillReloadCount ?? 0,
      skillTokensConsumed: scorecardSnapshot?.skillTokensConsumed ?? 0,
      decisionContradictions: scorecardSnapshot?.decisionContradictions ?? 0,
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
  /** TODO(M7): semantic flip detection — column kept at 0 until M7 lands. */
  decisionContradictions: number;
  turnEventSearches: number;
  totalTurns: number;
  pressureEvents: number;
  compactionTriggers: number;
  recallCalls: number;
  recallUsedCount: number;
  skillsLoaded: number;
  skillsUsed: number;
  skillUnderloadEvents: number;
  skillReloadCount: number;
  skillTokensConsumed: number;
}

interface ScorecardDbRow {
  session_id: string;
  context_engine_on: number;
  created_at: number;
  artifact_retrieve_calls: number;
  artifact_cards_produced: number;
  repeat_file_reads: number;
  decision_contradictions: number;
  turn_event_searches: number;
  total_turns: number;
  pressure_events: number;
  compaction_triggers: number;
  recall_calls: number;
  recall_used_count: number;
  validity_avg_start: number;
  validity_avg_end: number;
  usefulness_avg_start: number;
  usefulness_avg_end: number;
  skills_loaded: number;
  skills_used: number;
  skill_underload_events: number;
  skill_reload_count: number;
  skill_tokens_consumed: number;
}

export type ScorecardInc = Pick<ScorecardTracker, "inc" | "setSkillsUsed">;

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
    recallUsedCount: 0,
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
  inc(field: keyof ScorecardCounters, by = 1): void {
    if (!this.db) return; // null-object: no-op
    this.counters[field] = (this.counters[field] ?? 0) + by;
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

  /** Snapshot recall-used count for /stats and flush. */
  setRecallUsedCount(count: number): void {
    if (!this.db) return;
    this.recallUsedCount = count;
    this.counters.recallUsedCount = count;
  }

  /** Apply skill counters from SkillRuntime at session end (engine mode). */
  applySkillSnapshot(snapshot: {
    loaded: number;
    used: number;
    reloaded: number;
    underload: number;
    tokensConsumed: number;
  }): void {
    if (!this.db) return;
    this.counters.skillsLoaded = snapshot.loaded;
    this.counters.skillsUsed = snapshot.used;
    this.counters.skillReloadCount = snapshot.reloaded;
    this.counters.skillUnderloadEvents = snapshot.underload;
    this.counters.skillTokensConsumed = snapshot.tokensConsumed;
  }

  /** Close the scorecard DB (measurement-only mode; engine mode closes via ContextEngine). */
  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore double-close
    }
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
        return getMemorySignalAverages(memDb);
      } finally {
        memDb.close();
      }
    } catch {
      return { validityAvg: 0, usefulnessAvg: 0 };
    }
  }

  /** Restore in-memory counters from a previously persisted scorecard row (resume). */
  restoreFromDb(): boolean {
    if (!this.db) return false;
    const row = this.db
      .prepare("SELECT * FROM scorecard WHERE session_id = ?")
      .get(this.sessionId) as ScorecardDbRow | undefined;
    if (!row) return false;

    this.counters = {
      artifactRetrieveCalls: row.artifact_retrieve_calls ?? 0,
      artifactCardsProduced: row.artifact_cards_produced ?? 0,
      repeatFileReads: row.repeat_file_reads ?? 0,
      decisionContradictions: row.decision_contradictions ?? 0,
      turnEventSearches: row.turn_event_searches ?? 0,
      totalTurns: row.total_turns ?? 0,
      pressureEvents: row.pressure_events ?? 0,
      compactionTriggers: row.compaction_triggers ?? 0,
      recallCalls: row.recall_calls ?? 0,
      recallUsedCount: row.recall_used_count ?? 0,
      skillsLoaded: row.skills_loaded ?? 0,
      skillsUsed: row.skills_used ?? 0,
      skillUnderloadEvents: row.skill_underload_events ?? 0,
      skillReloadCount: row.skill_reload_count ?? 0,
      skillTokensConsumed: row.skill_tokens_consumed ?? 0,
    };
    this.recallUsedCount = row.recall_used_count ?? 0;
    this.validityAvgStart = row.validity_avg_start ?? 0;
    this.usefulnessAvgStart = row.usefulness_avg_start ?? 0;
    this.validityAvgEnd = row.validity_avg_end ?? 0;
    this.usefulnessAvgEnd = row.usefulness_avg_end ?? 0;
    return true;
  }

  /** Persist current counters without final memory end-state (called each turn). */
  persistProgress(): void {
    this.writeScorecardRow({ final: false });
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

    if (memoryDbPath) {
      const endAvgs = this.getMemoryAverages(memoryDbPath);
      this.validityAvgEnd = endAvgs.validityAvg;
      this.usefulnessAvgEnd = endAvgs.usefulnessAvg;
    }
    this.setRecallUsedCount(recallUsedCount);
    this.writeScorecardRow({ final: true });
  }

  private writeScorecardRow(_opts: { final: boolean }): void {
    if (!this.db) return;

    const existing = this.db
      .prepare("SELECT created_at FROM scorecard WHERE session_id = ?")
      .get(this.sessionId) as { created_at: number } | undefined;
    const createdAt = existing?.created_at ?? Date.now();

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
      createdAt,
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
