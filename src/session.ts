import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { ulid } from "ulid";
import type { CompileMetrics } from "./compiler.js";
import type { PraanaConfig, SkillRecord } from "./types.js";
import type { SkillTelemetryEvent } from "./skills/types.js";
import { SkillRuntime, discoverSkills } from "./skills/index.js";
import { EventLog, writeSessionMeta, readSessionMeta } from "./event-log.js";
import { StateGraph } from "./state-graph.js";
import { loadConfig } from "./config.js";
import {
  MemoryStore,
  createEmbedder,
  createSummarizer,
  type SessionEvent,
} from "./memory/index.js";
import { buildProjectContext } from "./project-detector.js";
import { runConsolidation, type ConsolidationConfig } from "./memory/consolidation.js";
import {
  ContextEngine,
  isContextEngineEnabled,
  renderSessionTelemetrySummary,
  resolveContextDbPath,
  resolveContextEngineConfig,
} from "./context-engine/index.js";
import type { CompileScoreRecord, PressureMode } from "./context-engine/types.js";
import {
  fetchAndCacheContextWindow,
  resolveContextWindowSync,
} from "./model-context.js";
import { APP_HOME_DIR, APP_AGENT_ID, appHomePath, resolveDefaultMemoryDbPath } from "./app-identity.js";
import { createSessionLogger, getAppLogger, type PraanaLogger } from "./logger.js";

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
  debug = false;
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
      const tokEst = Math.ceil(session.agentsContext.length / 4);
      session.getLogger().notice(`context ${tokEst} tok`, { domain: "session" });
    }

    initContextEngine(session);
    await initSkills(session, cfg, cwd);

    applyProjectContext(session, cwd);

    if (session.incognito) {
      session.memoryEnabled = false;
      session.memoryStore = null;
      session.digest = null;
      session.getLogger().notice("Cross-session memory persistence disabled (incognito)");
      await session.refreshModelContextWindow().catch((err) => {
        session.getLogger().child("session").warn("Failed to prefetch context window", {
          cause: err as Error,
        });
      });
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

    await session.refreshModelContextWindow().catch((err) => {
      session.getLogger().child("session").warn("Failed to prefetch context window", {
        cause: err as Error,
      });
    });

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
      const tokEst = Math.ceil(session.agentsContext.length / 4);
      session.getLogger().notice(`context ${tokEst} tok`, { domain: "session" });
    }

    initContextEngine(session);
    await initSkills(session, cfg, cwd);

    const allEvents = session.eventLog.readAll();

    // Replay state mutations chronologically. Reset markers intentionally clear
    // earlier context_action events so /clear remains effective after resume.
    for (const ev of allEvents) {
      if (ev.kind === "context_action") {
        session.stateGraph.replayAction(ev.payload);
      } else if (
        ev.kind === "system_note" &&
        ev.payload.type === "state_reset" &&
        ev.payload.cleared === "all"
      ) {
        session.stateGraph.clear();
      }
    }

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

    await session.refreshModelContextWindow().catch((err) => {
      session.getLogger().child("session").warn("Failed to prefetch context window", {
        cause: err as Error,
      });
    });

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

  clearState(): void {
    this.stateGraph.clear();
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
    const provider = this.getEffectiveProvider();
    const modelId = this.getActiveModelId();
    if (modelId.includes("/")) {
      const prefix = modelId.slice(0, modelId.indexOf("/"));
      if (prefix === provider) return modelId;
    }
    return `${provider}/${modelId}`;
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
      return p.startsWith("/") ? p : join(this.cwd, p);
    }
    return resolveDefaultMemoryDbPath();
  }

  getRepoRoot(): string {
    return findGitRoot(this.cwd);
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
  ): void {
    this.lastCompileScoreRecords = records;
    this.lastPressureMode = pressureMode;
    this.lastPressureRatio = pressureRatio;
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
  ): Promise<void> {
    if (this.ended) return;
    this.ended = true;

    if (this.memoryEnabled && this.memoryStore) {
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
        const finish = this.memoryStore.sessionEnd(reason, events);

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
      }
    }

    // Spawn background consolidation processor if enabled
    if (this.memoryEnabled && this.memoryStore && this.config.consolidation?.enabled) {
      const consolidationConfig: ConsolidationConfig = {
        enabled: true,
        promotion_threshold: this.config.consolidation.promotion_threshold ?? 3,
        run_delay_seconds: this.config.consolidation.run_delay_seconds ?? 30,
      };
      const sessionId = this.id;
      const store = this.memoryStore;
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
      }, consolidationConfig.run_delay_seconds * 1000);
    }

    if (this.contextEngine) {
      try {
        const engineConfig = resolveContextEngineConfig(this.config);
        if (this.debug || engineConfig.measurement_mode) {
          const summary = this.contextEngine.finalizeTelemetry(this.getTurnCount());
          this.getLogger().child("context_engine").debug(renderSessionTelemetrySummary(summary));
        }
        this.contextEngine.runShutdownMaintenance(this.getTurnCount());
      } catch (err) {
        this.getLogger().child("context_engine").warn("Shutdown maintenance failed", {
          cause: err as Error,
        });
      } finally {
        this.contextEngine.close();
        this.contextEngine = null;
      }
    }

    this.eventLog.close();
  }

  private async initMemoryStore(): Promise<MemoryStore> {
    const configuredPath = this.config.memory?.db_path;
    let dbPath: string;

    if (configuredPath) {
      dbPath = expandHome(configuredPath);
      if (!dbPath.startsWith("/")) dbPath = join(this.cwd, dbPath);
    } else {
      dbPath = resolveDefaultMemoryDbPath();
    }

    const embedder = await createEmbedder(this.config.memory);
    const summarizer = await createSummarizer(this.config.memory);

    return new MemoryStore({ dbPath, embedder, summarizer });
  }
}

// ---- Helpers ----

function initContextEngine(session: Session): void {
  if (!session.isContextEngineEnabled()) return;

  try {
    const dbPath = resolveContextDbPath(session.config, session.cwd);
    mkdirSync(dirname(dbPath), { recursive: true });
    session.contextEngine = ContextEngine.open(
      dbPath,
      session.id,
      resolveContextEngineConfig(session.config),
    );
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
  }
}

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
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
      details: { tokenEstimate: Math.ceil(combined.length / 4) },
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
  session.getLogger().notice(`fingerprint ${Math.ceil(projectContext.length / 4)} tok`, {
    domain: "session",
  });

  const engineActive =
    session.isContextEngineEnabled() && session.contextEngine !== null;
  if (engineActive) {
    session.stateGraph.create("constraint", { text: projectContext });
  }
}

/** Discover skills — SkillRuntime in engine mode, metadata catalog only in classic mode. */
async function initSkills(session: Session, cfg: PraanaConfig, cwd: string): Promise<void> {
  if (!cfg.skills?.enabled) return;

  if (session.isContextEngineEnabled() && session.contextEngine) {
    await initSkillRuntime(session, cfg, cwd);
    return;
  }

  session.skillRuntime = null;
  session.skills = discoverSkills(cwd, cfg.skills.max_depth);

  if (session.skills.length > 0) {
    session.getLogger().child("skills").notice(
      `${session.skills.length} skill(s) (classic catalog)`,
    );
  }
}

/** Discover skills and attach SkillRuntime to the session (residency resets on resume). */
async function initSkillRuntime(session: Session, cfg: PraanaConfig, cwd: string): Promise<void> {
  session.skillRuntime = new SkillRuntime(cfg.skills, cwd);
  if (!cfg.skills?.enabled) return;

  await session.skillRuntime.initialize();
  session.skills = session.skillRuntime.getIndex().map((e) => ({
    name: e.name,
    description: e.description,
    location: "",
    directory: "",
    body: "",
    metadata: { name: e.name, description: e.description },
  }));

  if (session.skills.length > 0) {
    session.getLogger().child("skills").notice(`${session.skills.length} skill(s)`);
  }
}
