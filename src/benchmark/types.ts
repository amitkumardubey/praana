// ============================================================
// Context Engine Benchmark — Types
// ============================================================

import type { CompileMetrics } from "../compiler.js";
import type { PressureMode, ScoredContextUnit } from "../context-engine/types.js";

/** A single turn's comparison between classic and engine compilation. */
export interface TurnComparison {
  turnNumber: number;
  classic: CompilationSnapshot;
  engine: CompilationSnapshot;
  /** Token ratio: engine / classic (< 1 means engine is smaller). */
  tokenRatio: number;
  /** Compression efficiency: (classic - engine) / classic. */
  compressionEfficiency: number;
}

/** Snapshot of a single compilation. */
export interface CompilationSnapshot {
  totalTokens: number;
  metrics: CompileMetrics;
  /** For engine: the scored units that were included/excluded. */
  scoredUnits?: {
    included: ScoredContextUnit[];
    excluded: ScoredContextUnit[];
  };
  /** For engine: the pressure mode at compilation time. */
  pressureMode?: PressureMode;
}

/** Aggregated metrics for a full session. */
export interface SessionBenchmark {
  sessionId: string;
  cwd: string;
  totalTurns: number;
  /** Average token ratio across turns (engine / classic). */
  avgTokenRatio: number;
  /** Average compression efficiency across turns. */
  avgCompressionEfficiency: number;
  /** Turn-by-turn comparisons. */
  turns: TurnComparison[];
  /** Pressure mode distribution. */
  pressureDistribution: Record<PressureMode, number>;
  /** Average score of included units (engine only). */
  avgIncludedScore: number;
  /** Average number of excluded units per turn (engine only). */
  avgExcludedUnits: number;
}

/** Full benchmark report across multiple sessions. */
export interface BenchmarkReport {
  sessions: SessionBenchmark[];
  summary: {
    totalSessions: number;
    totalTurns: number;
    /** Grand average token ratio across all sessions and turns. */
    avgTokenRatio: number;
    avgCompressionEfficiency: number;
    avgIncludedScore: number;
  };
  generatedAt: string;
}

/** Options for running a benchmark. */
export interface BenchmarkOptions {
  /** Session directories to benchmark (paths to events.jsonl). */
  sessions: string[];
  /** Engine config to use for context engine compilation. */
  engineConfig: string;
  /** Max turns to process per session (0 = all). */
  maxTurns?: number;
  /** Output path for the report JSON. */
  outputPath?: string;
}
