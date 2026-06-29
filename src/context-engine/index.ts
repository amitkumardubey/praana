import { homedir } from "node:os";
import { join } from "node:path";
import type { Event } from "../types.js";
import type { StateGraph } from "../state-graph.js";
import type { PraanaConfig } from "../types.js";
import { resolveDefaultMemoryDbPath } from "../app-identity.js";
import { ArtifactStore } from "./artifact-store.js";
import { CheckpointStore, renderContextSummary as formatContextSummary } from "./checkpoint.js";
import {
  buildEventLineage,
  formatEventLineage,
  type EventLineage,
} from "./event-lineage.js";
import { getTurnDigest, listSessionArtifacts } from "./db.js";
import {
  renderSessionTelemetrySummary,
  TelemetryRecorder,
  ScorecardTracker,
  type SessionTelemetrySummary,
} from "./telemetry.js";
import { TurnExtraction } from "./extraction.js";
import { TurnLedger } from "./turn-ledger.js";
import type { ContextEngineConfig } from "../types.js";
import type {
  ActivityEntry,
  CheckpointDraft,
  ContextArtifact,
  IngestToolResultInput,
  IngestToolResultOutput,
  RetrieveArtifactOptions,
  SessionCheckpoint,
  StateSnapshot,
  TurnDigest,
  TurnRecord,
  TurnSearchMatch,
} from "./types.js";

export type {
  ActivityEntry,
  ActivityEntryType,
  CheckpointDraft,
  ContentType,
  ContextArtifact,
  OpenError,
  ToolCallRecord,
  SessionCheckpoint,
  TurnDigest,
  TurnRecord,
  TurnSearchMatch,
} from "./types.js";
export type { ContextEngineConfig } from "../types.js";
export { CheckpointStore, renderCheckpoint, renderContextSummary } from "./checkpoint.js";
export { classifyContentType } from "./classify.js";
export { estimateTokens } from "./summarize.js";
export { ArtifactStore } from "./artifact-store.js";
export { TurnLedger, groupEventsIntoTurns } from "./turn-ledger.js";
export { TurnRecorder, buildTurnSearchText } from "./turn-recorder.js";
export { extractTurnDigest, extractUserIntent } from "./turn-digest.js";
export { snapshotStateGraph } from "./state-snapshot.js";
export { compileEngineWithMetrics, explainUnitScore } from "./engine-compiler.js";
export { scoreContextUnit, recencyScore } from "./scoring.js";
export { buildEventLineage, formatEventLineage, type EventLineage } from "./event-lineage.js";
export {
  TelemetryRecorder,
  ScorecardTracker,
  createNullScorecard,
  renderSessionTelemetrySummary,
  type SessionTelemetrySummary,
} from "./telemetry.js";

const CONTEXT_ENGINE_DEFAULTS: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 400,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: {
    w_pin: 1.0,
    w_recency: 0.5,
    w_relevance: 0.3,
  },
  pressure: {
    compact_at: 0.7,
    emergency_at: 0.85,
  },
};

export function normalizeContextEngineConfig(
  config: Partial<ContextEngineConfig> = {},
): ContextEngineConfig {
  return {
    ...CONTEXT_ENGINE_DEFAULTS,
    ...config,
    distiller: {
      ...CONTEXT_ENGINE_DEFAULTS.distiller,
      ...(config.distiller ?? {}),
    },
    scoring: {
      ...CONTEXT_ENGINE_DEFAULTS.scoring,
      ...(config.scoring ?? {}),
    },
    pressure: {
      ...CONTEXT_ENGINE_DEFAULTS.pressure,
      ...(config.pressure ?? {}),
    },
  };
}

export function resolveContextEngineConfig(config: PraanaConfig): ContextEngineConfig {
  return normalizeContextEngineConfig(config.context_engine ?? {});
}

export function isContextEngineEnabled(config: PraanaConfig): boolean {
  return resolveContextEngineConfig(config).enabled;
}

export function resolveContextDbPath(config: PraanaConfig, cwd: string): string {
  const configuredPath = config.memory?.db_path;
  if (configuredPath) {
    const expanded = expandHome(configuredPath);
    return expanded.startsWith("/") ? expanded : join(cwd, expanded);
  }
  return resolveDefaultMemoryDbPath();
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? p.replace(/^~\//, `${homedir()}/`) : p;
}

export class ContextEngine {
  readonly store: ArtifactStore;
  readonly ledger: TurnLedger;
  readonly extraction: TurnExtraction;
  readonly checkpoint: CheckpointStore | null;
  readonly telemetry: TelemetryRecorder;
  readonly scorecard: ScorecardTracker;
  private readonly config: ContextEngineConfig;

  private constructor(
    store: ArtifactStore,
    ledger: TurnLedger,
    extraction: TurnExtraction,
    checkpoint: CheckpointStore | null,
    telemetry: TelemetryRecorder,
    scorecard: ScorecardTracker,
    config: ContextEngineConfig,
  ) {
    this.store = store;
    this.ledger = ledger;
    this.extraction = extraction;
    this.checkpoint = checkpoint;
    this.telemetry = telemetry;
    this.scorecard = scorecard;
    this.config = config;
  }

  static open(
    dbPath: string,
    sessionId: string,
    config: Partial<ContextEngineConfig> & Pick<ContextEngineConfig, "enabled">,
  ): ContextEngine {
    const resolved = normalizeContextEngineConfig(config);
    const store = ArtifactStore.open(dbPath, sessionId, resolved);
    const ledger = new TurnLedger(store.getDb(), sessionId);
    const extraction = new TurnExtraction(store.getDb(), sessionId, resolved);
    const checkpoint = resolved.checkpoint_enabled
      ? CheckpointStore.open(store.getDb(), sessionId)
      : null;
    const telemetry = new TelemetryRecorder(store.getDb(), sessionId, resolved.enabled);
    const scorecard = new ScorecardTracker(store.getDb(), sessionId, resolved.enabled);
    return new ContextEngine(store, ledger, extraction, checkpoint, telemetry, scorecard, resolved);
  }

  runStartupMaintenance(currentTurn: number): number {
    return this.store.runEviction(currentTurn);
  }

  runShutdownMaintenance(currentTurn: number): number {
    return this.store.runEviction(currentTurn);
  }

  migrateLedgerFromEvents(events: Event[]): number {
    return this.ledger.migrateFromEvents(events);
  }

  captureStateSnapshot(stateGraph: StateGraph): StateSnapshot {
    return this.extraction.captureStateSnapshot(stateGraph);
  }

  ingestToolResult(input: IngestToolResultInput): IngestToolResultOutput {
    return this.store.ingestToolResult(input);
  }

  async flushDeferredDistillation(): Promise<number> {
    return this.store.flushDeferredDistillation();
  }

  appendTurn(record: TurnRecord): void {
    this.ledger.append(record);
  }

  processTurnExtraction(input: {
    userMessage: string;
    record: TurnRecord;
    stateBefore: StateSnapshot;
    stateGraph: StateGraph;
  }): TurnDigest {
    const digest = this.extraction.processTurn(input);
    if (this.checkpoint) {
      this.checkpoint.reconcile(
        digest,
        this.extraction.getCheckpointDraft(),
        digest.turnId,
      );
      this.checkpoint.persist();
    }
    return digest;
  }

  getRecentActivity(): ActivityEntry[] {
    return this.extraction.getRecentActivity();
  }

  getCheckpointDraft(): CheckpointDraft {
    return this.extraction.getCheckpointDraft();
  }

  getLatestDigest(): TurnDigest | null {
    return this.extraction.getLatestDigest();
  }

  renderCheckpointSection(): string | null {
    // Retained for checkpoint integration tests; runtime uses getSessionCheckpoint() + renderCheckpoint().
    if (!this.checkpoint) return null;
    const rendered = this.checkpoint.render();
    return rendered.length > 0 ? rendered : null;
  }

  renderContextSummary(): string {
    const artifactCount = this.store.countArtifacts();
    if (this.checkpoint) {
      return this.checkpoint.renderContextSummary({ artifactCount });
    }
    const draft = this.extraction.getCheckpointDraft();
    return draft.lastUserIntent
      ? formatContextSummary(
          {
            version: 1,
            state: {
              activeRequest: draft.lastUserIntent,
              plans: [],
              constraints: draft.recentConstraints,
              decisions: draft.recentDecisions.map((d) => ({ ...d, compact: false })),
              files: [],
              findings: [],
              errors: draft.openErrors.map((e) => ({
                key: e.key,
                message: e.message,
                turn: e.turn,
                fixed: false,
              })),
              questions: [],
              activity: draft.recentActivity,
              narrative: [],
              lastReconciledTurn: -1,
            },
          },
          { artifactCount },
        )
      : "## Context Summary\n\nNo checkpoint data yet.";
  }

  getSessionCheckpoint(): SessionCheckpoint | null {
    return this.checkpoint?.getCheckpoint() ?? null;
  }

  recordCompileTelemetry(input: {
    turn: number;
    pressureMode: import("./types.js").PressureMode;
    excludedScoredUnits: number;
  }): void {
    this.telemetry.recordCompileTelemetry(input);
  }

  finalizeTelemetry(totalTurns: number): SessionTelemetrySummary {
    return this.telemetry.finalize(totalTurns);
  }

  renderTelemetrySummary(totalTurns: number): string {
    return renderSessionTelemetrySummary(this.finalizeTelemetry(totalTurns));
  }

  searchTurnEvents(query: string, limit = 20, currentTurn?: number): TurnSearchMatch[] {
    const matches = this.ledger.search(query, limit);
    if (currentTurn !== undefined) {
      for (const match of matches) {
        for (const artifactId of match.artifactIds) {
          this.store.touchAccess(artifactId, currentTurn);
        }
      }
    }
    return matches;
  }

  eventLineage(
    artifactId: string,
    currentTurn: number,
  ): { ok: true; lineage: EventLineage; text: string } | { ok: false; error: string } {
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) {
      return { ok: false, error: `Artifact ${artifactId} not found` };
    }

    const sessionId = this.store.getSessionId();
    const db = this.store.getDb();
    const turnRecord = this.ledger.get(artifact.createdTurn);
    const turnDigest = getTurnDigest(db, sessionId, artifact.createdTurn);
    const checkpoint = this.checkpoint?.getCheckpoint() ?? null;
    const sessionArtifacts = listSessionArtifacts(db, sessionId);
    const turnRecords = this.ledger.list();

    const lineage = buildEventLineage({
      artifact,
      turnRecord,
      turnDigest,
      checkpoint,
      sessionArtifacts,
      turnRecords,
    });

    this.store.touchAccess(artifactId, currentTurn);
    this.telemetry.recordArtifactAccess(artifactId, "retrieved", currentTurn);
    for (const related of lineage.relatedArtifacts) {
      this.store.touchAccess(related.id, currentTurn);
      this.telemetry.recordArtifactAccess(related.id, "retrieved", currentTurn);
    }

    return { ok: true, lineage, text: formatEventLineage(lineage) };
  }

  retrieveArtifact(
    id: string,
    currentTurn: number,
    options?: RetrieveArtifactOptions,
  ): { ok: true; content: string } | { ok: false; error: string } {
    const result = this.store.retrieve(id, currentTurn, options);
    if (result.ok) {
      this.telemetry.recordArtifactAccess(id, "retrieved", currentTurn);
    }
    return result;
  }

  close(): void {
    this.store.close();
  }

  /**
   * M4 artifact promotion: list this session's high-value artifacts (those
   * accessed >= minAccessCount times). The actual promotion into Cognitive Memory
   * is done by the session via MemoryStore.remember, since the ContextEngine
   * does not depend on MemoryStore (preserves the per-session / Cognitive Memory
   * boundary).
   */
  listHighValueArtifacts(minAccessCount: number): ContextArtifact[] {
    return this.store.listHighValueArtifacts(minAccessCount);
  }
}
