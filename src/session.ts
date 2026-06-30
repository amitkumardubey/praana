import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { openDatabase } from "./sqlite.js";
import { ulid } from "ulid";
import type { CompileMetrics } from "./compiler.js";
import type { PraanaConfig, SkillRecord, Event } from "./types.js";
import type { SkillTelemetryEvent } from "./skills/types.js";
import { SkillRuntime, discoverSkills } from "./skills/index.js";
import { EventLog, writeSessionMeta, readSessionMeta } from "./event-log.js";
import { detectActivityLogNote } from "./tools/memory.js";
import { StateGraph } from "./state-graph.js";
import {
  deleteStateGraphCheckpoint,
  findReplayStartIndex,
  loadStateGraphCheckpoint,
  replayStateGraphFromEvents,
  saveStateGraphCheckpoint,
} from "./state-graph-checkpoint.js";
import { loadConfig } from "./config.js";
import {
  MemoryStore,
  createEmbedder,
  resolveEmbeddingBackend,
  createSummarizer,
  type SessionEvent,
} from "./memory/index.js";
import { buildProjectContext } from "./project-detector.js";
import { runConsolidation, type ConsolidationConfig } from "./memory/consolidation.js";
import { getMemorySignalAverages } from "./memory/db.js";
import { openContextEngineDb } from "./context-engine/db.js";
import {
  ContextEngine,
  isContextEngineEnabled,
  ScorecardTracker,
  createNullScorecard,
  renderSessionTelemetrySummary,
  resolveContextDbPath,
  resolveContextEngineConfig,
  type ScorecardTrackerOptions,
} from "./context-engine/index.js";
import type { CompileScoreRecord, PressureMode } from "./context-engine/types.js";
import { EmbeddingCache } from "./context-engine/embedding-cache.js";
import {
  fetchAndCacheContextWindow,
  resolveContextWindowSync,
} from "./model-context.js";
import { formatActiveModelLabel } from "./model-resolver.js";
import { APP_HOME_DIR, APP_AGENT_ID, appHomePath, resolveDefaultMemoryDbPath } from "./app-identity.js";
import { createSessionLogger, getAppLogger, type PraanaLogger } from "./logger.js";
import { estimateTokens } from "./token-estimate.js";

/** Outcome of the session-end memory summarization step. */
export type SessionEndStatus = {
  memory: "completed" | "background" | "skipped" | "failed";
};

export class Session {
  id: string;
  cwd: string;
  config: PraanaConfig;
  eventLog: EventLog;
  stateGraph: StateGraph;
  memoryStore: MemoryStore | null = null;
  memoryEnabled: boolean;
  incognito = false;
  digest: string | null = null;
  agentsContext: string | null = null;  // content from AGENTS.md / CLAUDE.md
  projectContext: string | null = null; // stack fingerprint from package.json, README, etc.
  skills: SkillRecord[] = [];           // discovered skills (re-discovered on resume; residency resets)
  skillRuntime: SkillRuntime | null = null;
  contextEngine: ContextEngine | null = null;
  embeddingCache: EmbeddingCache | null = null;
  scorecard: ScorecardTracker = createNullScorecard();
  debug = false;
  /** Last task type classified during compilation (issue #92 — workflow tracking). */
  private lastKnownTaskType: string | null = null;
  private ended = false;
  private readonly startedAt: number;
  private turnCount = 0;
  private modelOverride: string | null = null;
  private providerOverride: string | null = null;
  private modelContextWindow: number | null = null;
  private modelContextWindowFor: string | null = null;
  private lastCompileMetrics: CompileMetrics | null = null;
  private lastCompileScoreRecords: CompileScoreRecord[] = [];
  private lastPressureMode: PressureMode = "normal";
  private lastPressureRatio = 0;
  private lastWeightedTokens = 0;
  private lastRawPressureRatio = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private lastUserInput = "";
  private compactionArmed = false;
  private sessionLogger: PraanaLogger | null = null;
  private noticeCapture?: (line: string) => void;

  private constructor(id: string, cwd: string, config: PraanaConfig, startedAt: number) {
    this.id = id;
    this.cwd = cwd;
    this.config = config;
    this.startedAt = startedAt;

    const logDir = config.session.log_dir;
    this.eventLog = new EventLog(id, logDir);

    this.stateGraph = new StateGraph();
    this.memoryEnabled = config.memory.enabled;
  }

  static createNew(id: string, cwd: string, config: PraanaConfig): Session {
    const startedAt = Date.now();
    const session = new Session(id, cwd, config, startedAt);

    writeSessionMeta(config.session.log_dir, {
      session_id: id,
      started_at: startedAt,
      cwd,
      agent: APP_AGENT_ID,
    });

    return session;
  }

  static async create(
    cwd: string,
    config?: PraanaConfig,
    opts?: { incognito?: boolean; captureNotice?: (line: string) => void }
  ): Promise<Session> {
    const cfg = config ?? loadConfig();
    const id = ulid();
    const session = Session.createNew(id, cwd, cfg);
    session.incognito = opts?.incognito ?? false;
    session.noticeCapture = opts?.captureNotice;
    await session.initLogger();
    session.agentsContext = loadAgentsContext(cwd);
    if (session.agentsContext) {
      const tokEst = estimateTokens(session.agentsContext);
      session.getLogger().notice(`context ${tokEst} tok`, { domain: "session" });
    }

    initContextEngine(session);
    await initSkills(session, cfg, cwd);

    applyProjectContext(session, cwd);

    if (session.incognito) {
      session.memoryEnabled = false;
      session.memoryStore = null;
      session.digest = null;
      session.getLogger().notice("Cognitive Memory persistence disabled (incognito)");
      return session;
    }

    if (session.memoryEnabled) {
      try {
        session.memoryStore = await session.initMemoryStore();
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "session_start_begin",
          },
        });

        const d = await session.memoryStore.sessionStart({
          agent: APP_AGENT_ID,
          user_id: hashString(process.env.USER ?? "unknown"),
          time: Date.now(),
          context_id: hashString(cwd),
          context_label: basename(cwd),
          working_context: { repo: { root: cwd, name: basename(cwd) } },
          recall_min_score: cfg.compiler.recall_min_score ?? 0.35,
        });

        session.digest = d.markdown;
        // Record memory start averages for scorecard
        const memDbPath = session.getMemoryDbPath();
        if (memDbPath) {
          await session.scorecard.recordMemoryStart(memDbPath);
        }
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "session_start_success",
            digestLength: session.digest.length,
          },
        });
      } catch (err) {
        session.getLogger().child("memory").warn("Failed to initialize, continuing without memory", {
          code: "MEMORY_INIT_FAILED",
          cause: err as Error,
        });
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "session_start_failure",
            error: (err as Error).message,
          },
        });
        session.memoryEnabled = false;
        session.memoryStore = null;
        session.digest = null;
      }
    }

    return session;
  }

  static async resume(
    sessionId: string,
    cwd: string,
    config?: PraanaConfig,
    opts?: { captureNotice?: (line: string) => void }
  ): Promise<Session> {
    const cfg = config ?? loadConfig();
    const meta = readSessionMeta(cfg.session.log_dir, sessionId);
    if (!meta) {
      throw new Error(`Session ${sessionId} not found.`);
    }

    const session = new Session(sessionId, cwd, cfg, meta.started_at);
    session.noticeCapture = opts?.captureNotice;
    await session.initLogger();
    session.agentsContext = loadAgentsContext(cwd);
    if (session.agentsContext) {
      const tokEst = estimateTokens(session.agentsContext);
      session.getLogger().notice(`context ${tokEst} tok`, { domain: "session" });
    }

    initContextEngine(session);
    await initSkills(session, cfg, cwd);

    const allEvents = session.eventLog.readAll();
    session.restoreWorkingMemory(allEvents);

    loadProjectContextField(session, cwd);

    // Restore model + provider overrides from the latest system_note events.
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const ev = allEvents[i];
      if (ev.kind !== "system_note") continue;
      if (ev.payload.type === "provider_override" && session.providerOverride === null) {
        const rawProvider = ev.payload.provider;
        if (typeof rawProvider === "string" && rawProvider.trim()) {
          session.providerOverride = rawProvider.trim();
        }
      }
      if (ev.payload.type === "model_override" && session.modelOverride === null) {
        const rawModel = ev.payload.model;
        if (typeof rawModel === "string" && rawModel.trim()) {
          session.modelOverride = rawModel.trim();
        }
      }
      if (session.modelOverride !== null && session.providerOverride !== null) break;
    }

    if (session.memoryEnabled) {
      try {
        session.memoryStore = await session.initMemoryStore();
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "resume_session_start_begin",
          },
        });

        // For resumed sessions, regenerate digest
        const d = await session.memoryStore.sessionStart({
          agent: APP_AGENT_ID,
          user_id: hashString(process.env.USER ?? "unknown"),
          time: Date.now(),
          context_id: hashString(cwd),
          context_label: basename(cwd),
          working_context: { repo: { root: cwd, name: basename(cwd) } },
          recall_min_score: cfg.compiler.recall_min_score ?? 0.35,
        });

        session.digest = d.markdown;
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "resume_session_start_success",
            digestLength: session.digest.length,
          },
        });
      } catch (err) {
        session.getLogger().child("memory").warn("Failed to initialize for resumed session", {
          code: "MEMORY_INIT_FAILED",
          cause: err as Error,
        });
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "resume_session_start_failure",
            error: (err as Error).message,
          },
        });
        session.memoryEnabled = false;
        session.memoryStore = null;
      }
    }

    return session;
  }


  isContextEngineEnabled(): boolean {
    return isContextEngineEnabled(this.config);
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  incrementTurn(): void {
    this.turnCount++;
    this.stateGraph.incrementTurn();
  }

  /** Record the task type from the most recent compilation (issue #92). */
  setLastKnownTaskType(taskType: string): void {
    this.lastKnownTaskType = taskType;
  }

  clearState(): void {
    this.stateGraph.clear();
  }

  /** Persist working-memory state for fast resume (issue #74). */
  persistStateGraphCheckpoint(): void {
    const lastEvent = this.eventLog.getLastEvent();
    if (!lastEvent) return;

    const sessionDir = join(this.config.session.log_dir, this.id);
    const checkpoint = this.stateGraph.exportCheckpoint(
      lastEvent.event_id,
      this.turnCount,
    );
    saveStateGraphCheckpoint(sessionDir, checkpoint);
  }

  /** Load checkpoint + replay post-checkpoint state mutations (issue #74). */
  private restoreWorkingMemory(allEvents: Event[]): void {
    const sessionDir = join(this.config.session.log_dir, this.id);
    const checkpoint = loadStateGraphCheckpoint(sessionDir);

    if (!checkpoint) {
      // No checkpoint — pre-feature or deleted session. Start with empty state.
      return;
    }

    const startIndex = findReplayStartIndex(allEvents, checkpoint.last_event_id);
    if (startIndex === null) {
      this.getLogger().child("session").warn(
        "State graph checkpoint anchor missing — starting with empty state",
      );
      deleteStateGraphCheckpoint(sessionDir);
      return;
    }

    this.stateGraph.restoreFromCheckpoint(checkpoint);
    this.turnCount = checkpoint.session_turn_count;
    replayStateGraphFromEvents(this.stateGraph, allEvents, startIndex);
  }

  getStartedAt(): number {
    return this.startedAt;
  }

  getUptimeMs(): number {
    return Math.max(0, Date.now() - this.startedAt);
  }

  getActiveModelId(): string {
    return this.modelOverride ?? this.config.llm.model;
  }

  getEffectiveProvider(): string {
    return this.providerOverride ?? this.config.llm.provider;
  }

  getEffectiveLlmConfig(): PraanaConfig["llm"] {
    return { ...this.config.llm, provider: this.getEffectiveProvider() };
  }

  getActiveModelLabel(): string {
    return formatActiveModelLabel(this.getEffectiveProvider(), this.getActiveModelId());
  }

  getProviderOverride(): string | null {
    return this.providerOverride;
  }

  setProviderOverride(provider: string | null): void {
    const next = provider && provider.trim() ? provider.trim() : null;
    if (next === this.providerOverride) return;
    this.providerOverride = next;
    this.modelContextWindow = null;
    this.modelContextWindowFor = null;
  }

  getLogger(): PraanaLogger {
    if (!this.sessionLogger) {
      return getAppLogger().child("session");
    }
    return this.sessionLogger;
  }

  async initLogger(): Promise<void> {
    if (this.sessionLogger) return;
    this.sessionLogger = await createSessionLogger({
      sessionId: this.id,
      sessionLogDir: this.config.session.log_dir,
      debug: this.debug,
      captureNotice: this.noticeCapture,
    });
  }

  getContextWindowTokens(modelId?: string): number {
    const id = modelId ?? this.getActiveModelId();
    if (this.modelContextWindowFor === id && this.modelContextWindow !== null) {
      return this.modelContextWindow;
    }
    return resolveContextWindowSync(
      this.getEffectiveProvider(),
      id,
      this.config.llm.context_window,
    );
  }

  async refreshModelContextWindow(modelId?: string): Promise<number> {
    const id = modelId ?? this.getActiveModelId();
    const window = await fetchAndCacheContextWindow(
      this.getEffectiveProvider(),
      id,
      this.config.llm.context_window,
    );
    this.modelContextWindow = window;
    this.modelContextWindowFor = id;
    return window;
  }

  async ensureModelContextWindow(modelId?: string): Promise<number> {
    const id = modelId ?? this.getActiveModelId();
    if (this.modelContextWindowFor === id && this.modelContextWindow !== null) {
      return this.modelContextWindow;
    }
    return this.refreshModelContextWindow(id);
  }

  setModelOverride(model: string | null): void {
    const next = model && model.trim() ? model.trim() : null;
    if (next === this.modelOverride) return;
    this.modelOverride = next;
    this.modelContextWindow = null;
    this.modelContextWindowFor = null;
  }

  getModelOverride(): string | null {
    return this.modelOverride;
  }

  isIncognito(): boolean {
    return this.incognito;
  }

  recordInputTokens(count: number): void {
    this.sessionInputTokens += count;
  }

  recordOutputTokens(count: number): void {
    this.sessionOutputTokens += count;
  }

  getInputTokens(): number {
    return this.sessionInputTokens;
  }

  getOutputTokens(): number {
    return this.sessionOutputTokens;
  }

  async setIncognito(enabled: boolean): Promise<void> {
    this.incognito = enabled;
    if (enabled) {
      this.memoryEnabled = false;
      this.memoryStore = null;
      this.digest = null;
      return;
    }

    if (!this.config.memory.enabled) return;

    try {
      this.memoryStore = await this.initMemoryStore();
      const d = await this.memoryStore.sessionStart({
        agent: APP_AGENT_ID,
        user_id: hashString(process.env.USER ?? "unknown"),
        time: Date.now(),
        context_id: hashString(this.cwd),
        context_label: basename(this.cwd),
        working_context: { repo: { root: this.cwd, name: basename(this.cwd) } },
        recall_min_score: this.config.compiler.recall_min_score ?? 0.35,
      });
      this.digest = d.markdown;
      this.memoryEnabled = true;
    } catch (err) {
      this.getLogger().child("memory").warn("Failed to re-enable memory", {
        code: "MEMORY_INIT_FAILED",
        cause: err as Error,
      });
      this.memoryEnabled = false;
      this.memoryStore = null;
      this.digest = null;
    }
  }

  get promptDir(): string {
    return join(this.config.session.log_dir, this.id, "prompts");
  }

  getMemoryDbPath(): string | null {
    const configuredPath = this.config.memory?.db_path;
    if (configuredPath) {
      const p = expandHome(configuredPath);
      return p === ":memory:" || p.startsWith("/") ? p : join(this.cwd, p);
    }
    return resolveDefaultMemoryDbPath();
  }

  /**
   * Snapshot recall-used count before memory sessionEnd deletes pending_reinforcements.
   */
  getRecallUsedCount(): number {
    const store = this.memoryStore;
    if (!store || typeof store.countPendingReinforcementsUsed !== "function") {
      return 0;
    }
    return store.countPendingReinforcementsUsed();
  }

  /** Track read_file paths for repeat-read scorecard signal (session-scoped digests). */
  trackScorecardFileRead(absPath: string): void {
    this.scorecard.trackReadPath(absPath);
  }

  /** Whether scorecard persistence is active for this session. */
  isScorecardEnabled(): boolean {
    return this.scorecard.isActive();
  }

  getScorecardEngineOn(): boolean {
    return this.contextEngine !== null && this.isContextEngineEnabled();
  }

  private syncScorecardFromRuntime(): void {
    if (this.skillRuntime) {
      const snapshot = this.skillRuntime.getSkillScorecard();
      this.scorecard.applySkillSnapshot(snapshot);
    }
  }

  getRepoRoot(): string {
    return findGitRoot(this.cwd);
  }

  /**
   * Promote surviving add_note entries from working memory to Cognitive
   * Memory at session end. Only notes that are not retracted,
   * not hard-tiered, and not activity-log quality pass through.
   * (#129)
   */
  private async promoteSurvivingNotesToMemory(): Promise<void> {
    if (!this.memoryStore) return;

    const extractText = (payload: unknown): string | undefined =>
      payload && typeof payload === "object" && "text" in payload
        ? (payload as { text: unknown }).text as string | undefined
        : undefined;

    const notes = this.stateGraph
      .snapshot()
      .filter((obj) => {
        if (obj.kind !== "note" || obj.retracted || obj.tier === "hard") return false;
        const text = extractText(obj.payload);
        return text && !detectActivityLogNote(text);
      });

    if (notes.length === 0) return;

    let promoted = 0;
    let reinforced = 0;
    for (const note of notes) {
      const text = extractText(note.payload);
      if (!text) continue;
      try {
        const result = await this.memoryStore.remember(text, {
          kind: "fact",
          certainty: "high",
        });
        if (result.reinforced) {
          reinforced++;
        } else {
          promoted++;
        }
      } catch (err) {
        this.getLogger().child("memory").warn(`Failed to promote note ${note.id}`, {
          cause: err as Error,
        });
      }
    }

    if (promoted > 0 || reinforced > 0) {
      this.getLogger().child("memory").info(
        `Note promotion: ${promoted} new, ${reinforced} reinforced-dedup`,
      );
    }
  }

  /** Current git branch name, or null when detached/not a git repo. */
  getGitBranch(): string | null {
    return findGitBranch(this.cwd);
  }

  setLastCompileMetrics(metrics: CompileMetrics): void {
    this.lastCompileMetrics = metrics;
  }

  getLastCompileMetrics(): CompileMetrics | null {
    return this.lastCompileMetrics;
  }

  setLastCompileScoreRecords(
    records: CompileScoreRecord[],
    pressureMode: PressureMode,
    pressureRatio: number,
    weightedTokens = 0,
    rawPressureRatio = 0,
  ): void {
    this.lastCompileScoreRecords = records;
    this.lastPressureMode = pressureMode;
    this.lastPressureRatio = pressureRatio;
    this.lastWeightedTokens = weightedTokens;
    this.lastRawPressureRatio = rawPressureRatio;
  }

  getLastCompileScoreRecords(): CompileScoreRecord[] {
    return this.lastCompileScoreRecords;
  }

  getCompileScoreRecord(unitId: string): CompileScoreRecord | undefined {
    return this.lastCompileScoreRecords.find((r) => r.unitId === unitId);
  }

  getLastPressureMode(): PressureMode {
    return this.lastPressureMode;
  }

  getLastPressureRatio(): number {
    return this.lastPressureRatio;
  }

  getLastWeightedTokens(): number {
    return this.lastWeightedTokens;
  }

  getLastRawPressureRatio(): number {
    return this.lastRawPressureRatio;
  }

  setLastUserInput(input: string): void {
    this.lastUserInput = input;
  }

  getLastUserInput(): string {
    return this.lastUserInput;
  }

  isCompactionArmed(): boolean {
    return this.compactionArmed;
  }

  setCompactionArmed(armed: boolean): void {
    this.compactionArmed = armed;
  }

  getMemoryStats(): {
    total: number;
    active: number;
    soft: number;
    hard: number;
    byKind: Record<string, number>;
  } {
    const snapshot = this.stateGraph.snapshot();
    const byKind: Record<string, number> = {};
    let active = 0;
    let soft = 0;
    let hard = 0;

    for (const obj of snapshot) {
      byKind[obj.kind] = (byKind[obj.kind] ?? 0) + 1;
      if (obj.tier === "active") active++;
      else if (obj.tier === "soft") soft++;
      else hard++;
    }

    return { total: snapshot.length, active, soft, hard, byKind };
  }

  getPersistentMemoryEntryCount(): number | null {
    if (!this.memoryEnabled || !this.memoryStore) return null;
    return this.memoryStore.getEntryCount();
  }

  async runMemoryDedupe(): Promise<{ clustersMerged: number; entriesRemoved: number }> {
    if (!this.memoryStore) {
      throw new Error("Memory store is not available.");
    }
    const result = await this.memoryStore.reconcileDuplicates();
    const digest = await this.memoryStore.getDigest(
      this.config.compiler.recall_min_score ?? 0.35,
    );
    this.digest = digest.markdown;
    return result;
  }

  getSessionSummary(): {
    turns: number;
    stateObjects: number;
    memoriesStored: number;
  } {
    const events = this.eventLog.readAll();
    let turns = 0;
    let memoriesStored = 0;
    for (const ev of events) {
      if (ev.kind === "user_message") turns++;
      if (ev.kind !== "tool_result") continue;
      if (ev.payload.tool !== "remember") continue;
      const result = ev.payload.result as Record<string, unknown> | undefined;
      if (result?.ok === true) memoriesStored++;
    }
    return {
      turns,
      stateObjects: this.stateGraph.snapshot().length,
      memoriesStored,
    };
  }

  /** Build a transcript of user/agent/tool events for the summarizer. */
  getTranscriptEvents(): SessionEvent[] {
    const all = this.eventLog.readAll();
    const out: SessionEvent[] = [];
    for (const ev of all) {
      if (ev.kind === "user_message" || ev.kind === "agent_message") {
        out.push({ type: ev.kind, timestamp: ev.timestamp, content: (ev.payload.text as string) ?? "" });
      } else if (ev.kind === "tool_call") {
        out.push({ type: "tool_use", timestamp: ev.timestamp, tool_name: ev.payload.tool as string, args: ev.payload.args as Record<string, unknown> | undefined });
      } else if (ev.kind === "tool_result") {
        out.push({ type: "tool_result", timestamp: ev.timestamp, tool_name: ev.payload.tool as string, result: ev.payload.result });
      }
    }
    return out;
  }

  async end(
    reason: "clean" | "aborted" | "error",
    events?: SessionEvent[],
    opts?: { memoryTimeoutMs?: number }
  ): Promise<SessionEndStatus> {
    if (this.ended) return { memory: "skipped" };
    this.ended = true;

    let memoryStatus: SessionEndStatus["memory"] = "skipped";
    const recallUsedCount = this.getRecallUsedCount();

    if (this.memoryEnabled && this.memoryStore) {
      const store = this.memoryStore;
      const memoryTimeoutMs = opts?.memoryTimeoutMs ?? 0;
      try {
        this.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "session_end_begin",
            reason,
          },
        });
        this.getLogger().child("memory").info(`Session end begun (reason: ${reason})`);
        const finish = store.sessionEnd(reason, events);

        if (memoryTimeoutMs > 0) {
          const completed = await waitForCompletion(finish, memoryTimeoutMs);
          if (completed) {
            this.eventLog.append({
              kind: "system_note",
              actor: "kernel",
              payload: {
                type: "memory_lifecycle",
                phase: "session_end_success",
                reason,
              },
            });
            this.getLogger().child("memory").info(`Session end succeeded (reason: ${reason})`);
            memoryStatus = "completed";
          } else {
            // Ensure late failures are not unhandled after we stop waiting.
            void finish.catch((err: unknown) => {
              this.getLogger().child("memory").warn("Background session-end task failed", {
                cause: err as Error,
              });
            });
            this.getLogger().child("memory").warn("Session-end summarization is continuing in background");
            this.eventLog.append({
              kind: "system_note",
              actor: "kernel",
              payload: {
                type: "memory_lifecycle",
                phase: "session_end_background",
                reason,
                timeoutMs: memoryTimeoutMs,
              },
            });
            this.getLogger().child("memory").info(`Session end continuing in background (reason: ${reason})`);
            memoryStatus = "background";
          }
        } else {
          await finish;
          this.eventLog.append({
            kind: "system_note",
            actor: "kernel",
            payload: {
              type: "memory_lifecycle",
              phase: "session_end_success",
              reason,
            },
          });
          this.getLogger().child("memory").info(`Session end succeeded (reason: ${reason})`);
          memoryStatus = "completed";
        }
      } catch (err) {
        this.getLogger().child("memory").warn("Error during session end", {
          cause: err as Error,
        });
        this.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: {
            type: "memory_lifecycle",
            phase: "session_end_failure",
            reason,
            error: (err as Error).message,
          },
        });
        this.getLogger().child("memory").warn(`Session end failed (reason: ${reason})`, { cause: err as Error });
        memoryStatus = "failed";
      }

      // Spawn background consolidation processor if enabled
      if (this.config.consolidation?.enabled) {
        const consolidationConfig: ConsolidationConfig = {
          enabled: true,
          promotion_threshold: this.config.consolidation.promotion_threshold ?? 3,
          run_delay_seconds: this.config.consolidation.run_delay_seconds ?? 30,
        };
        const sessionId = this.id;
        const transcriptEvents = events ?? this.getTranscriptEvents();

        setTimeout(async () => {
          try {
            const summarizer = store.getSummarizer();
            if (!summarizer) return;
            const result = await runConsolidation({
              store,
              llm: summarizer,
              sessionId,
              events: transcriptEvents,
              config: consolidationConfig,
            });
            if (result.promotions > 0) {
              this.getLogger().child("memory").info(
                `Consolidated: ${result.promotions} patterns promoted to deep memory`,
              );
            }
            if (result.newEntries > 0 || result.confirmations > 0) {
              this.getLogger().child("memory").info(
                `Consolidation complete: ${result.newEntries} new, ${result.confirmations} confirmed, ${result.contradictions} contradicted`,
              );
            }
          } catch (err) {
            this.getLogger().child("memory").warn("Background consolidation failed", {
              cause: err as Error,
            });
          }
        }, consolidationConfig.run_delay_seconds * 1000).unref();
      }

      // #129: promote surviving notes to cognitive memory at session end
      try {
        await this.promoteSurvivingNotesToMemory();
      } catch (err) {
        this.getLogger().child("memory").warn("Note promotion failed", {
          cause: err as Error,
        });
      }
    }

    if (this.contextEngine) {
      try {
        const engineConfig = resolveContextEngineConfig(this.config);
        if (this.debug || engineConfig.measurement_mode) {
          this.syncScorecardFromRuntime();
          const summary = this.contextEngine.finalizeTelemetry(this.getTurnCount());
          this.getLogger().child("context_engine").debug(renderSessionTelemetrySummary(summary));

          // Skills summary (issue #96 report card) — engine mode only
          if (this.skillRuntime) {
            const skillStats = this.skillRuntime.getLoadedSkillStats();
            this.getLogger().child("skills").debug(
              `Skills: catalog=${skillStats.catalogSize} loaded=${skillStats.loadedCount} ` +
              `reloaded=${skillStats.reloadedCount} evicted=${skillStats.evictedCount} ` +
              `under_load=${skillStats.catalogSize - skillStats.loadedCount}`,
            );
          }
        }
        this.contextEngine.runShutdownMaintenance(this.getTurnCount());
      } catch (err) {
        this.getLogger().child("context_engine").warn("Shutdown maintenance failed", {
          cause: err as Error,
        });
      }

      // Workflow pattern tracking (issue #92): persist session pattern before
      // the engine closes its DB, so it is available for future sessions.
      try {
        const sessionArtifacts = this.contextEngine.listSessionArtifacts();
        const taskType = this.lastKnownTaskType ?? "general";
        const persisted = this.contextEngine.persistWorkflowPattern(
          taskType,
          sessionArtifacts,
        );
        if (persisted) {
          this.getLogger().child("context_engine").debug(
            `Workflow pattern persisted for taskType=${taskType}`,
          );
        }
      } catch (err) {
        this.getLogger().child("context_engine").warn("Workflow pattern persistence failed", {
          cause: err as Error,
        });
      }

      // M4 artifact promotion (build-spec §4 / decisions/003 Finding #14):
      // high-value session artifacts (accessed >= MIN_ARTIFACT_ACCESS_COUNT
      // times) are promoted into Cognitive Memory so they survive session
      // end. Runs once at session end, before the engine closes its DB.
      if (this.memoryEnabled && this.memoryStore) {
        try {
          await this.promoteHighValueArtifactsToMemory();
        } catch (err) {
          this.getLogger().child("memory").warn("Artifact promotion failed", {
            cause: err as Error,
          });
        }
      }
    }

    const contextEngineToClose = this.contextEngine;

    // Flush scorecard while the context DB is still open (shares connection with ContextEngine).
    try {
      this.syncScorecardFromRuntime();
      const memPath = this.getMemoryDbPath();
      await this.scorecard.flush(memPath ?? undefined, recallUsedCount);
    } catch (err) {
      this.getLogger().child("context_engine").warn("Scorecard flush failed", {
        cause: err as Error,
      });
    }

    if (contextEngineToClose) {
      try {
        contextEngineToClose.close();
      } catch (err) {
        this.getLogger().child("context_engine").warn("Context engine close failed", {
          cause: err as Error,
        });
      }
      this.contextEngine = null;
    } else {
      this.scorecard.close();
    }

    this.persistStateGraphCheckpoint();
    this.eventLog.close();
    return { memory: memoryStatus };
  }

  /**
   * M4 artifact promotion (build-spec §4 / decisions/003 Finding #14).
   * Promote high-value session artifacts — those accessed at least
   * MIN_ARTIFACT_ACCESS_COUNT times — into Cognitive Memory. These are
   * the artifacts the agent had to revisit to do its job; the spec flags
   * them as more useful than the one-sentence summary the summarizer would
   * otherwise extract.
   *
   * - Triggers on access_count >= MIN_ARTIFACT_ACCESS_COUNT (default 2).
   * - Stores the artifact's *summary* (already distilled; raw is too large
   *   and would be hard-truncated by MemoryStore.remember anyway).
   * - kind: "fact"; scope: project (caller-provided default scopes already
   *   include context:<cwd>); the existing dedup path prevents re-stating
   *   a previously-promoted artifact from creating a second row.
   * - Failures are caught and logged (M4 must not block session shutdown).
   */
  private async promoteHighValueArtifactsToMemory(): Promise<void> {
    if (!this.contextEngine || !this.memoryStore) return;
    // Threshold of 3: a file read twice in one session is normal; three
    // accesses signals the agent genuinely kept returning to it.
    const MIN_ARTIFACT_ACCESS_COUNT = 3;
    const artifacts = this.contextEngine.listHighValueArtifacts(
      MIN_ARTIFACT_ACCESS_COUNT,
    );
    if (artifacts.length === 0) return;
    // Only promote artifacts whose distilled summary is human-readable prose.
    // code/json/search_results/other are produced by GenericDistiller and
    // contain raw JSON blobs or head-tail truncated source — not learnings.
    const PROMOTABLE_CONTENT_TYPES = new Set(["prose", "diff", "log", "test_output", "build_output"]);
    let promoted = 0;
    let reinforced = 0;
    let skipped = 0;
    for (const artifact of artifacts) {
      if (!PROMOTABLE_CONTENT_TYPES.has(artifact.contentType)) {
        skipped++;
        continue;
      }
      // Extra guard: skip if the summary looks like a JSON blob (starts with {).
      const trimmedSummary = artifact.summary.trimStart();
      if (trimmedSummary.startsWith("{") || trimmedSummary.startsWith("[")) {
        skipped++;
        continue;
      }
      // Cap to 200 chars — matches the learning size from the LLM summariser.
      const content = trimmedSummary.slice(0, 200);
      try {
        const result = await this.memoryStore.remember(content, {
          kind: "fact",
          certainty: "medium",
        });
        if (result.reinforced) {
          reinforced++;
        } else {
          promoted++;
        }
      } catch (err) {
        this.getLogger().child("memory").warn(
          `Failed to promote artifact ${artifact.id}`,
          { cause: err as Error },
        );
      }
    }
    this.getLogger().child("memory").info(
      `Artifact promotion: ${promoted} new, ${reinforced} reinforced-dedup, ${skipped} skipped (min access=${MIN_ARTIFACT_ACCESS_COUNT})`,
    );
  }

  private async initMemoryStore(): Promise<MemoryStore> {
    const configuredPath = this.config.memory?.db_path;
    let dbPath: string;

    if (configuredPath) {
      dbPath = expandHome(configuredPath);
      if (dbPath !== ":memory:" && !dbPath.startsWith("/")) dbPath = join(this.cwd, dbPath);
    } else {
      dbPath = resolveDefaultMemoryDbPath();
    }

    const embedder = await createEmbedder(this.config.memory);
    const summarizer = await createSummarizer(this.config.memory);

    return new MemoryStore({
      dbPath,
      embedder,
      summarizer,
      logger: this.getLogger(),
      embeddingBackend: resolveEmbeddingBackend(this.config.memory, embedder),
    });
  }
}

// ---- Helpers ----

function initContextEngine(session: Session): void {
  const engineConfig = resolveContextEngineConfig(session.config);
  const measurementMode = engineConfig.measurement_mode;
  const scorecardOptions = createScorecardOptions(session.cwd);

  if (!session.isContextEngineEnabled()) {
    // Measurement mode: open a minimal context DB just for the scorecard
    if (measurementMode) {
      try {
        const dbPath = resolveContextDbPath(session.config, session.cwd);
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = openContextEngineDb(dbPath);
        session.scorecard = new ScorecardTracker(db, session.id, false, scorecardOptions);
        session.scorecard.restoreFromDb();
        session.getLogger().child("context_engine").notice("measurement mode enabled (scorecard only)");
      } catch (err) {
        session.getLogger().child("context_engine").warn("Failed to initialize measurement mode", {
          cause: err as Error,
        });
        session.scorecard = createNullScorecard();
      }
    }
    return;
  }

  try {
    const dbPath = resolveContextDbPath(session.config, session.cwd);
    mkdirSync(dirname(dbPath), { recursive: true });
    session.contextEngine = ContextEngine.open(
      dbPath,
      session.id,
      engineConfig,
      scorecardOptions,
    );
    session.scorecard = session.contextEngine.scorecard;
    session.scorecard.restoreFromDb();
    const evicted = session.contextEngine.runStartupMaintenance(session.getTurnCount());
    const migrated = session.contextEngine.migrateLedgerFromEvents(
      session.eventLog.readAll(),
    );
    const ceLog = session.getLogger().child("context_engine");
    if (evicted > 0) {
      ceLog.notice(`context engine evicted ${evicted} stale artifact(s)`);
    } else if (migrated > 0) {
      ceLog.notice(`context engine migrated ${migrated} turn(s) to ledger`);
    } else {
      ceLog.notice("context engine enabled");
    }
  } catch (err) {
    session.getLogger().child("context_engine").warn("Failed to initialize, continuing without context engine", {
      cause: err as Error,
    });
    session.contextEngine = null;
    if (measurementMode) {
      session.scorecard = createNullScorecard();
    }
  }
}

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function createScorecardOptions(cwd: string): ScorecardTrackerOptions {
  const contextScope = `context:${hashString(cwd)}`;
  return {
    memoryAverages: (memoryDbPath) => readScopedMemoryAverages(memoryDbPath, contextScope),
  };
}

function readScopedMemoryAverages(
  memoryDbPath: string,
  contextScope: string,
): { validityAvg: number; usefulnessAvg: number } {
  try {
    const memDb = openDatabase(memoryDbPath, { readonly: true });
    try {
      return getMemorySignalAverages(memDb, contextScope);
    } finally {
      memDb.close();
    }
  } catch {
    return { validityAvg: 0, usefulnessAvg: 0 };
  }
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? p.replace(/^~\//, `${homedir()}/`) : p;
}

async function waitForCompletion(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });
  const done = promise.then(() => true);
  return Promise.race([done, timeout]);
}

/** Find git root of the given directory, or return the directory itself. */
function findGitRoot(cwd: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

/** Current git branch, or null when detached HEAD or not in a git repo. */
function findGitBranch(cwd: string): string | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!branch || branch === "HEAD") return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * Load project context from AGENTS.md / CLAUDE.md files.
 *
 * Load order (all non-empty results are merged):
 *   1. ~/.praana/AGENTS.md — global personal instructions
 *   2. <git root>/AGENTS.md    — project-wide context
 *   3. <cwd>/AGENTS.md         — subdirectory context (if cwd ≠ git root)
 *   4. CLAUDE.md fallback      — if no AGENTS.md found at project root
 *
 * Combined content is capped at ~4000 tokens (16000 chars).
 */
export function loadAgentsContext(cwd: string): string | null {
  const MAX_CHARS = 16_000; // ~4000 tokens
  const parts: string[] = [];

  const tryRead = (filePath: string, label: string): void => {
    if (!existsSync(filePath)) return;
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) parts.push(`<!-- ${label} -->\n${content}`);
    } catch { /* unreadable, skip */ }
  };

  // 1. Global personal instructions
  tryRead(appHomePath("AGENTS.md"), `~/${APP_HOME_DIR}/AGENTS.md`);

  // 2. Project root AGENTS.md
  const gitRoot = findGitRoot(cwd);
  tryRead(join(gitRoot, "AGENTS.md"), "AGENTS.md");

  // 3. Subdirectory AGENTS.md (only if cwd differs from git root)
  if (cwd !== gitRoot) {
    tryRead(join(cwd, "AGENTS.md"), `${basename(cwd)}/AGENTS.md`);
  }

  // 4. CLAUDE.md fallback — only if no AGENTS.md was found at project root
  if (!existsSync(join(gitRoot, "AGENTS.md"))) {
    tryRead(join(gitRoot, "CLAUDE.md"), "CLAUDE.md");
    if (cwd !== gitRoot) {
      tryRead(join(cwd, "CLAUDE.md"), `${basename(cwd)}/CLAUDE.md`);
    }
  }

  if (parts.length === 0) return null;

  const combined = parts.join("\n\n");
  if (combined.length > MAX_CHARS) {
    getAppLogger().child("session").warn("AGENTS.md content truncated to ~4000 tokens", {
      details: { tokenEstimate: estimateTokens(combined) },
    });
    return combined.slice(0, MAX_CHARS) + "\n\n<!-- [truncated] -->";
  }
  return combined;
}
export { buildProjectContext };

function loadProjectContextField(session: Session, cwd: string): void {
  if (!session.config.project_detection?.enabled) {
    session.projectContext = null;
    return;
  }

  session.projectContext = buildProjectContext(cwd, {
    languages: session.config.project_detection.manual_languages,
    frameworks: session.config.project_detection.manual_frameworks,
  });
}

/** Load stack fingerprint on session start; StateGraph constraint only for engine mode. */
function applyProjectContext(session: Session, cwd: string): void {
  loadProjectContextField(session, cwd);
  const projectContext = session.projectContext;
  if (!projectContext) return;

  session.eventLog.append({
    kind: "system_note",
    actor: "kernel",
    payload: {
      type: "project_context_loaded",
      summary: projectContext.slice(0, 100),
    },
  });
  session.getLogger().notice(`fingerprint ${estimateTokens(projectContext)} tok`, {
    domain: "session",
  });

  const engineActive =
    session.isContextEngineEnabled() && session.contextEngine !== null;
  if (engineActive) {
    session.stateGraph.create("constraint", { text: projectContext });
  }
}

/** Discover skills. Engine mode additionally creates a SkillRuntime for tracking. */
async function initSkills(session: Session, cfg: PraanaConfig, cwd: string): Promise<void> {
  if (!cfg.skills?.enabled) return;

  session.skills = discoverSkills(cwd, cfg.skills.max_depth);

  if (session.isContextEngineEnabled() && session.contextEngine) {
    session.skillRuntime = new SkillRuntime(cfg.skills, cwd);
    await session.skillRuntime.initialize();
  } else {
    session.skillRuntime = null;
  }

  if (session.skills.length > 0) {
    session.getLogger().child("skills").notice(`${session.skills.length} skill(s)`);
  }
}
