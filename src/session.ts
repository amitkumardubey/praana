import { homedir } from "node:os";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { ulid } from "ulid";
import type { CompileMetrics } from "./compiler.js";
import type { ContextDisplaySnapshot } from "./context-display.js";
import type { PraanaConfig, SkillRecord, Event, StateObject } from "./types.js";
import { SkillRuntime, discoverSkills } from "./skills/index.js";
import { SkillStatsStore } from "./skills/skill-stats-store.js";
import { hashString } from "./hash.js";
import { findGitBranch, findGitRoot } from "./git-context.js";
import {
  EventLog,
  writeSessionMeta,
  readSessionMeta,
  findLastResetBoundaryTurn,
} from "./event-log.js";
import { StateGraph } from "./state-graph.js";
import { CANONICAL_TRANSCRIPT_VERSION } from "./canonical-transcript.js";
import {
  deleteStateGraphCheckpoint,
  findReplayStartIndex,
  loadStateGraphCheckpoint,
  replayStateGraphFromEvents,
  saveStateGraphCheckpoint,
} from "./state-graph-checkpoint.js";
import { loadConfig } from "./config.js";
import { createConfirmLock } from "./risk/confirm-lock.js";
import { promptYesNo } from "./risk/prompt.js";
import type { RiskClass, RiskConfirmResult } from "./risk/classes.js";
import type { ActionConfirmResult, ActionConfirmRequest, ConfirmHandler } from "./confirm/action.js";
import {
  actionPreviewLines,
  writeActionConfirmPreview,
} from "./confirm/action.js";
import { DEFAULT_WEB_CONFIG, decideWebHost, normalizeHost } from "./tools/web/policy.js";
import { SessionNotFoundError } from "./session-errors.js";
export { SessionNotFoundError } from "./session-errors.js";
import { isSessionGood, type SessionEvent } from "./session-outcome.js";
import { createEmbedder, resolveEmbeddingBackend } from "./memory/embedder-factory.js";
import type { Embedder } from "./memory/types.js";
import { createFileMemoryStore } from "./file-memory/store.js";
import type { FileMemoryStore } from "./file-memory/index.js";
import { buildProjectContext } from "./project-detector.js";
import { openContextEngineDb } from "./context-engine/db.js";
import {
  ContextEngine,
  isContextEngineEnabled,
  ScorecardTracker,
  createNullScorecard,
  renderSessionTelemetrySummary,
  resolveContextDbPath,
  resolveContextEngineConfig,
} from "./context-engine/index.js";
import type { CompileScoreRecord, PressureMode } from "./context-engine/types.js";
import { EmbeddingCache } from "./context-engine/embedding-cache.js";
import { createBuiltinHookRegistry, type HookRegistry } from "./hooks/index.js";
import { LoopGate } from "./circuit/loop-gate.js";
import {
  fetchAndCacheContextWindow,
  resolveContextWindowSync,
} from "./model-context.js";
import { formatActiveModelLabel } from "./model-resolver.js";
import {
  APP_HOME_DIR,
  APP_AGENT_ID,
  appHomePath,
  resolveAgainstCwd,
  resolveDefaultMemoryDbPath,
} from "./app-identity.js";
import { createSessionLogger, getAppLogger, type PraanaLogger } from "./logger.js";
import { estimateTokens } from "./token-estimate.js";
import { createEmptyCheckpoint } from "./context-engine/checkpoint.js";
import type { SessionCheckpoint } from "./context-engine/types.js";
import { probeNativeStatus, setNativeEnabled, tryGetNative, type NativeAddonStatus } from "./native/index.js";
import { LspManager } from "./lsp/manager.js";

async function probeSearchStatus(): Promise<string> {
  try {
    const native = await tryGetNative();
    return native ? "available" : "unavailable";
  } catch {
    return "unavailable: probe failed";
  }
}

/**
 * Return the checkpoint visible to the compiler after applying a reset_boundary.
 * A checkpoint last reconciled at or before the boundary predates a /clear and
 * is replaced with an empty checkpoint. Checkpoints reconciled after the
 * boundary (post-clear state) are returned unchanged. A negative boundaryTurn
 * means no /clear has occurred and the checkpoint is always visible as-is.
 */
export function visibleCheckpointAfterBoundary(
  checkpoint: SessionCheckpoint,
  boundaryTurn: number,
): SessionCheckpoint {
  if (boundaryTurn >= 0 && checkpoint.state.lastReconciledTurn <= boundaryTurn) {
    return createEmptyCheckpoint();
  }
  return checkpoint;
}

/** Shutdown outcome; deliberate file memory writes need no session-end flush. */
export type SessionEndStatus = {
  memory: "completed" | "background" | "skipped" | "failed" | "noop";
  turns: number;
  stateObjects: number;
  /** Mid-session `remember` tool successes. */
  rememberCalls: number;
  /** Successful file recall calls (query or by-name). */
  recallUsed: number;
  /** Compatibility field; automatic memory extraction is disabled, so always 0. */
  learningsStored: number;
};

export class Session {
  id: string;
  cwd: string;
  config: PraanaConfig;
  eventLog: EventLog;
  stateGraph: StateGraph;
  fileMemory: FileMemoryStore | null = null;
  memoryEnabled: boolean;
  memoryError: string | null = null;
  /** Semantic scoring belongs to the session, not the persistence backend. */
  embedder: Embedder | null = null;
  embeddingBackend = "keyword-only";
  /** Start-of-session prompt-index snapshot: `shown` entries in the compiled
   * prompt, `total` entries available at start (null when memory is off or
   * unavailable). Never refreshed after in-session writes. */
  private memoryPromptIndex: { shown: number; total: number } | null = null;
  /** Native addon status probed at session start (issue #587). */
  nativeStatus: NativeAddonStatus | null = null;
  /** Whether native search (search_code / find_files) is available. */
  fffStatus: string | null = null;
  canonicalTranscriptEnabled = false;
  incognito = false;
  digest: string | null = null;
  agentsContext: string | null = null;  // content from AGENTS.md / CLAUDE.md
  projectContext: string | null = null; // stack fingerprint from package.json, README, etc.
  skills: SkillRecord[] = [];           // discovered skills (re-discovered on resume; residency resets)
  skillRuntime: SkillRuntime | null = null;
  skillStatsStore: SkillStatsStore | null = null;
  skillUsefulness: Map<string, number> | null = null;
  contextEngine: ContextEngine | null = null;
  embeddingCache: EmbeddingCache | null = null;
  scorecard: ScorecardTracker = createNullScorecard();
  debug = false;
  /**
   * True for `praana run` / Harbor one-shots. Risk confirm fail-closes
   * without a TTY unless the class is in `[risk].allow`.
   */
  headless = false;
  /** When true, mutating tools are blocked until the user approves the plan. */
  planMode = false;
  /** Hosts the user already confirmed for web_fetch in this process. */
  private webFetchHosts = new Set<string>();
  /** In-flight confirmations per host, so a concurrent batch prompts once. */
  private webFetchInflight = new Map<string, Promise<RiskConfirmResult>>();
  /**
   * UI-supplied risk confirmation (the TUI overlay). When unset, the classic
   * readline prompt on stdin/stderr is used. The optional second argument
   * carries structured data the overlay renders — an action preview — so it is
   * never guessed out of the prompt text.
   */
  private confirmHandler: ConfirmHandler | null = null;
  /** Internal turn-loop hook dispatcher (issue #574). */
  hooks: HookRegistry;
  /** Mutating-tool loop breaker (issue #578). */
  loopGate: LoopGate;
  /** Session-scoped LSP client manager (issue #418 Phase 2). */
  lspManager: LspManager;
  /** Last task type classified during compilation (issue #482 — workflow tracking). */
  private lastKnownTaskType: string | null = null;
  private ended = false;
  private readonly startedAt: number;
  private turnCount = 0;
  private modelOverride: string | null = null;
  private providerOverride: string | null = null;
  /** Session `/reasoning` override; null → use config.llm.reasoning_effort. */
  private reasoningEffortOverride: string | null = null;
  /** Last wire `reasoningEffort` passed to pi-ai (null = omitted / not yet used). */
  private lastReasoningEffortUsed: string | null = null;
  private modelContextWindow: number | null = null;
  private modelContextWindowFor: string | null = null;
  private lastCompileMetrics: CompileMetrics | null = null;
  private lastCompileScoreRecords: CompileScoreRecord[] = [];
  private lastPressureMode: PressureMode = "normal";
  private lastPressureRatio = 0;
  private lastWeightedTokens = 0;
  private lastRawPressureRatio = 0;
  private displayContextSnapshot: ContextDisplaySnapshot | null = null;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private lastUserInput = "";
  private compactionArmed = false;
  private sessionLogger: PraanaLogger | null = null;
  private noticeCapture?: (line: string) => void;
  private suppressLoggerStderr = false;
  /** True if this session was just resumed and no new user turn has been processed yet. */
  private resumed = false;
  private readonly confirmLock = createConfirmLock();

  private constructor(id: string, cwd: string, config: PraanaConfig, startedAt: number) {
    this.id = id;
    this.cwd = cwd;
    this.config = config;
    this.startedAt = startedAt;

    const logDir = config.session.log_dir;
    this.eventLog = new EventLog(id, logDir);

    this.stateGraph = new StateGraph();
    this.loopGate = new LoopGate({
      threshold: config.circuit?.loop_threshold ?? 3,
      onFirstBlock: (text) => {
        this.stateGraph.create("constraint", { text });
        this.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: { type: "circuit_note", text },
        });
      },
    });
    this.memoryEnabled = config.memory.enabled;
    this.lspManager = new LspManager({
      config: config.lsp ?? {
        enabled: false,
        diagnostics: true,
        format_on_edit: false,
        timeout_ms: 5000,
        max_file_lines: 10_000,
        servers: {},
      },
      cwd,
      workspaceRoot: findGitRoot(cwd),
    });
    this.hooks = createBuiltinHookRegistry(cwd, {
      lspManager: this.lspManager,
      onFormattedPath: (absPath) => {
        this.scorecard.clearReadPath(absPath);
        this.contextEngine?.clearFileReadAllRanges(absPath);
      },
      verify: config.verify,
    });
    setNativeEnabled(config.native?.enabled ?? true);
  }

  static createNew(id: string, cwd: string, config: PraanaConfig): Session {
    const startedAt = Date.now();
    const session = new Session(id, cwd, config, startedAt);
    session.canonicalTranscriptEnabled = true;

    writeSessionMeta(config.session.log_dir, {
      session_id: id,
      started_at: startedAt,
      cwd,
      agent: APP_AGENT_ID,
      canonical_transcript: { version: CANONICAL_TRANSCRIPT_VERSION },
    });

    return session;
  }

  static async create(
    cwd: string,
    config?: PraanaConfig,
    opts?: {
      incognito?: boolean;
      captureNotice?: (line: string) => void;
      suppressLoggerStderr?: boolean;
    }
  ): Promise<Session> {
    const cfg = config ?? loadConfig();
    const id = ulid();
    const session = Session.createNew(id, cwd, cfg);
    session.incognito = opts?.incognito ?? false;
    session.noticeCapture = opts?.captureNotice;
    session.suppressLoggerStderr = opts?.suppressLoggerStderr ?? false;
    await session.initLogger();
    session.agentsContext = loadAgentsContext(cwd, {
      logger: session.getLogger(),
    });
    if (session.agentsContext) {
      const tokEst = estimateTokens(session.agentsContext);
      session.getLogger().notice(`context ${tokEst} tok`, { domain: "session" });
    }

    initContextEngine(session);
    await initSkills(session, cfg, cwd);

    applyProjectContext(session, cwd);

    await session.initFileMemory();
    await session.initEmbedder();

    session.nativeStatus = await probeNativeStatus();
    try {
      session.fffStatus = await probeSearchStatus();
    } catch {
      session.fffStatus = "unavailable: probe failed";
    }
    await session.hooks.runSessionStart({ session, reason: "create" });
    return session;
  }

  static async resume(
    sessionId: string,
    cwd: string,
    config?: PraanaConfig,
    opts?: {
      incognito?: boolean;
      captureNotice?: (line: string) => void;
      suppressLoggerStderr?: boolean;
    }
  ): Promise<Session> {
    const cfg = config ?? loadConfig();
    const meta = readSessionMeta(cfg.session.log_dir, sessionId);
    if (!meta) {
      throw new SessionNotFoundError(sessionId);
    }

    const session = new Session(sessionId, cwd, cfg, meta.started_at);
    session.incognito = opts?.incognito ?? false;
    session.canonicalTranscriptEnabled = meta.canonical_transcript?.version === CANONICAL_TRANSCRIPT_VERSION;
    session.noticeCapture = opts?.captureNotice;
    session.suppressLoggerStderr = opts?.suppressLoggerStderr ?? false;
    await session.initLogger();
    session.agentsContext = loadAgentsContext(cwd, {
      logger: session.getLogger(),
    });
    if (session.agentsContext) {
      const tokEst = estimateTokens(session.agentsContext);
      session.getLogger().notice(`context ${tokEst} tok`, { domain: "session" });
    }

    initContextEngine(session);
    await initSkills(session, cfg, cwd);

    const allEvents = session.eventLog.readAll();
    session.loopGate = LoopGate.fromEvents(allEvents, {
      threshold: cfg.circuit?.loop_threshold ?? 3,
      onFirstBlock: (text) => {
        session.stateGraph.create("constraint", { text });
        session.eventLog.append({
          kind: "system_note",
          actor: "kernel",
          payload: { type: "circuit_note", text },
        });
      },
    });
    // Checkpoint ids may refer to internal events; resolve on the raw log.
    session.restoreWorkingMemory(session.eventLog.readAll({ includeInternal: true }));

    loadProjectContextField(session, cwd);

    // Restore model + provider overrides, reasoning effort, and plan mode
    // from the latest system_note events.
    let planModeRestored = false;
    let reasoningEffortRestored = false;
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
        // Older /model writes embedded provider on model_override without a
        // separate provider_override event. Restore it only when still unset so
        // an explicit provider_override (found later in reverse scan) wins.
        if (session.providerOverride === null) {
          const rawProvider = ev.payload.provider;
          if (typeof rawProvider === "string" && rawProvider.trim()) {
            session.providerOverride = rawProvider.trim();
          }
        }
      }
      if (
        ev.payload.type === "reasoning_effort_override" &&
        !reasoningEffortRestored
      ) {
        const rawEffort = ev.payload.effort;
        if (typeof rawEffort === "string" && rawEffort.trim()) {
          session.reasoningEffortOverride = rawEffort.trim();
        }
        reasoningEffortRestored = true;
      }
      if (ev.payload.type === "plan_mode" && !planModeRestored) {
        session.planMode = ev.payload.value === true;
        planModeRestored = true;
      }
      if (
        session.modelOverride !== null &&
        session.providerOverride !== null &&
        planModeRestored &&
        reasoningEffortRestored
      ) {
        break;
      }
    }

    await session.initFileMemory();
    await session.initEmbedder();

    session.resumed = true;
    session.nativeStatus = await probeNativeStatus();
    try {
      session.fffStatus = await probeSearchStatus();
    } catch {
      session.fffStatus = "unavailable: probe failed";
    }
    await session.hooks.runSessionStart({ session, reason: "resume" });
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

  /**
   * Mark the session as no longer in the post-resume window. Called after the
   * first user turn is processed.
   */
  clearResumed(): void {
    this.resumed = false;
  }

  /**
   * Whether the session was resumed and the first post-resume user turn has
   * not yet been processed.
   */
  isResumed(): boolean {
    return this.resumed;
  }

  /**
   * Return active tasks that have been idle for longer than the configured
   * stale threshold. Used to surface a resume banner and scope confirmation.
   */
  getStaleTasks(): StateObject[] {
    const threshold = this.config.session.stale_task_turn_threshold ?? 5;
    if (threshold <= 0) return [];
    const currentTurn = this.turnCount;
    return this.stateGraph.getActive().filter((obj) => {
      if (obj.kind !== "task") return false;
      const touchedTurn = this.stateGraph.getTouchedTurn(obj.id);
      return currentTurn - touchedTurn > threshold;
    });
  }

  /** Record the task type from the most recent compilation (issue #482). */
  setLastKnownTaskType(taskType: string): void {
    this.lastKnownTaskType = taskType;
  }

  /** Enter plan mode: mutating tools are blocked until the user approves the plan. */
  enterPlanMode(): void {
    this.setPlanMode(true);
  }

  /** Exit plan mode: mutating tools are allowed again. */
  exitPlanMode(): void {
    this.setPlanMode(false);
  }

  /** Whether the session is currently in plan mode. */
  isPlanMode(): boolean {
    return this.planMode;
  }

  webFetchPolicy(host: string): "disabled" | "deny" | "allow" | "confirm" {
    const web = this.config.tools?.web ?? DEFAULT_WEB_CONFIG;
    if (!web.enabled) return "disabled";
    return decideWebHost(host, web);
  }

  webFetchHostRemembered(host: string): boolean {
    return this.webFetchHosts.has(normalizeHost(host));
  }

  rememberWebFetchHost(host: string): void {
    const name = normalizeHost(host);
    if (name) this.webFetchHosts.add(name);
  }

  /**
   * Install the UI's risk confirmation (the TUI overlay) or pass `null` to go
   * back to the classic readline prompt. Headless sessions never prompt.
   */
  setConfirmHandler(handler: ConfirmHandler | null): void {
    this.confirmHandler = handler;
  }

  /**
   * Confirm a web_fetch host, sharing one prompt per host. `turn.ts` runs tool
   * calls concurrently, so several fetches to the same new host would each
   * pass the "not remembered yet" check and prompt in turn. The first caller
   * creates the prompt; later callers await the same result.
   */
  confirmWebFetchHost(host: string, prompt: string): Promise<RiskConfirmResult> {
    const name = normalizeHost(host);
    if (name && this.webFetchHosts.has(name)) return Promise.resolve({ allowed: true });
    const pending = name ? this.webFetchInflight.get(name) : undefined;
    if (pending) return pending;
    const confirmation = this.confirmRisk("web_fetch_host", prompt).then((result) => {
      if (result.allowed && name) this.webFetchHosts.add(name);
      return result;
    });
    if (name) {
      this.webFetchInflight.set(name, confirmation);
      void confirmation.finally(() => {
        this.webFetchInflight.delete(name);
      });
    }
    return confirmation;
  }

  async confirmRisk(classId: RiskClass, prompt: string): Promise<RiskConfirmResult> {
    const allow = this.config.risk?.allow ?? [];
    if (this.headless) {
      return allow.includes(classId)
        ? { allowed: true }
        : { allowed: false, reason: "headless" };
    }
    return this.askInteractive(prompt, "Risk confirmation failed; declining", {
      details: { class: classId },
    });
  }

  /**
   * Confirm an action that is not a risk class: `edit_file` and `git_commit`
   * when `edit.confirm` is on (#748). Shares the risk path's lock, UI handler,
   * and classic fallback, so a TUI session asks in the overlay instead of
   * fighting OpenTUI for stdin — the readline prompt closed as declined before
   * the answer arrived and leaked mouse reports and chat input into the tools.
   *
   * The two paths ask differently. The UI handler gets the question plus the
   * preview as structured data (`options.preview`), because the overlay lays
   * out the rows itself. The classic terminal path prints the coloured preview
   * and then asks the short question, exactly as the tools did before. There is
   * no `[risk].allow` escape: a headless run cannot ask, so it refuses instead
   * of blocking or guessing.
   */
  async confirmAction(request: ActionConfirmRequest): Promise<ActionConfirmResult> {
    if (this.headless) return { allowed: false, reason: "headless" };
    return this.askInteractive(
      request.question,
      "Action confirmation failed; declining",
      {
        preview: () => actionPreviewLines(request),
        classicPreview: () => writeActionConfirmPreview(request),
      },
    );
  }

  /**
   * One serialised interactive question: the UI handler when the TUI installed
   * one, else the classic readline prompt. The two paths differ on purpose.
   * `preview` supplies the structured preview the overlay renders beside the
   * question. `classicPreview` prints the tool's coloured preview to stderr and
   * the short `prompt` is then asked, which is exactly what the tools did
   * before, so the preview is never shown twice. A handler failure is a decline
   * — never an implicit yes — and is logged.
   */
  private askInteractive(
    prompt: string,
    failureNote: string,
    options?: {
      details?: Record<string, unknown>;
      /** Structured preview lines the overlay renders under the question. */
      preview?: () => readonly string[];
      /** Classic-only coloured preview, printed before the question. */
      classicPreview?: () => void;
    },
  ): Promise<RiskConfirmResult | ActionConfirmResult> {
    return this.confirmLock(async () => {
      try {
        const handler = this.confirmHandler;
        if (handler) {
          const preview = options?.preview?.();
          const yes = await handler(
            prompt,
            preview === undefined ? undefined : { preview },
          );
          return yes ? { allowed: true } : { allowed: false, reason: "declined" };
        }
        options?.classicPreview?.();
        const yes = await promptYesNo(prompt);
        return yes ? { allowed: true } : { allowed: false, reason: "declined" };
      } catch (err) {
        const details = options?.details;
        const logOpts: { details?: Record<string, unknown>; cause: Error } = {
          cause: err as Error,
        };
        if (details) logOpts.details = details;
        this.getLogger().child("tool").warn(failureNote, logOpts);
        return { allowed: false, reason: "declined" };
      }
    });
  }

  observeCircuitPre(toolName: string, args: Record<string, unknown>) {
    const result = this.loopGate.observePre(toolName, args);
    if (result?.action === "block") {
      this.scorecard.inc("circuitLoopBlocks");
    }
    return result;
  }

  observeCircuitPost(toolName: string, args: Record<string, unknown>, isError: boolean): void {
    this.loopGate.observePost(toolName, args, isError);
  }

  circuitNotes(): string[] {
    return this.loopGate.notes();
  }

  private setPlanMode(value: boolean): void {
    if (this.planMode === value) return;
    this.planMode = value;
    this.eventLog.append({
      kind: "system_note",
      actor: "kernel",
      payload: { type: "plan_mode", value },
    });
  }

  clearState(): void {
    this.stateGraph.clear();
  }

  /** Append a reset boundary event to the event log. */
  logResetBoundary(command: string, reason?: string): void {
    this.eventLog.logResetBoundary(command, reason);
  }

  /**
   * Recalculate the context pressure baseline from events visible after the last
   * reset boundary. Used after /clear so the status bar and turn footer show the
   * actual remaining context, not the pre-reset high-water mark.
   */
  recalculateContextBaseline(): void {
    this.lastCompileMetrics = null;
    this.lastCompileScoreRecords = [];
    this.lastPressureMode = "normal";
    this.lastPressureRatio = 0;
    this.lastWeightedTokens = 0;
    this.lastRawPressureRatio = 0;
    this.displayContextSnapshot = null;
    this.compactionArmed = false;
  }

  /** Return the last turn number before the most recent reset boundary, or -1 if none. */
  getLastResetBoundaryTurn(): number {
    return findLastResetBoundaryTurn(this.eventLog.readAll());
  }

  /**
   * Session checkpoint for prompt compile, respecting reset_boundary.
   * Returns undefined when the engine is off. Returns an empty checkpoint when
   * the persisted checkpoint predates the most recent reset_boundary (i.e. it
   * was last reconciled before a /clear). Post-clear checkpoints reconciled
   * after the boundary are returned as-is.
   */
  getVisibleSessionCheckpoint(): SessionCheckpoint | undefined {
    if (!this.contextEngine) return undefined;
    const checkpoint = this.contextEngine.getSessionCheckpoint();
    if (!checkpoint) return undefined;
    return visibleCheckpointAfterBoundary(
      checkpoint,
      this.getLastResetBoundaryTurn(),
    );
  }

  /** Persist working-memory state for fast resume (issue #464). */
  persistStateGraphCheckpoint(): void {
    const lastEvent = this.eventLog.getLastEvent({ includeInternal: true });
    if (!lastEvent) return;

    const sessionDir = join(this.config.session.log_dir, this.id);
    const checkpoint = this.stateGraph.exportCheckpoint(
      lastEvent.event_id,
      this.turnCount,
    );
    saveStateGraphCheckpoint(sessionDir, checkpoint);
  }

  /** Load checkpoint + replay post-checkpoint state mutations (issue #464). */
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

  /** Interactive TUI sessions silence logger stderr so raw log lines don't
   *  corrupt the terminal surface; details still go to the log files. */
  shouldSuppressLoggerStderr(): boolean {
    return this.suppressLoggerStderr;
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
      suppressStderr: this.suppressLoggerStderr,
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

  setReasoningEffortOverride(effort: string | null): void {
    const next = effort && effort.trim() ? effort.trim() : null;
    if (next === this.reasoningEffortOverride) return;
    this.reasoningEffortOverride = next;
    this.eventLog.append({
      kind: "system_note",
      actor: "kernel",
      payload: { type: "reasoning_effort_override", effort: next },
    });
  }

  getReasoningEffortOverride(): string | null {
    return this.reasoningEffortOverride;
  }

  /** Session override, else config default (`medium`). */
  getEffectiveReasoningEffort(): string {
    return (
      this.reasoningEffortOverride ??
      this.config.llm.reasoning_effort ??
      "medium"
    );
  }

  /** Last `reasoningEffort` value passed to the LLM stream (null if omitted). */
  recordReasoningEffortUsed(effort: string | undefined): void {
    this.lastReasoningEffortUsed = effort ?? null;
  }

  getLastReasoningEffortUsed(): string | null {
    return this.lastReasoningEffortUsed;
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

  /** Toggle write access by building the replacement store before swapping it
   * with the flag. If rebuilding fails when turning incognito off, the old store
   * and flag stay in place. If enabling incognito fails, the writable store is
   * dropped and memory is disabled (fail closed). In either case an error string
   * is returned, not thrown. The index is a cache-stable prefix: a successful
   * toggle never rebuilds it.
   * When memory is disabled (or was disabled by an init failure) there is no
   * store to rebuild, so the flag is updated directly and null returned. */
  async setIncognito(enabled: boolean): Promise<string | null> {
    if (!this.memoryEnabled) {
      this.incognito = enabled;
      return null;
    }
    let nextStore: FileMemoryStore;
    try {
      nextStore = this.createFileMemory(enabled);
    } catch (err) {
      const error = memoryErrorMessage(err, appHomePath("memory"));
      this.getLogger().child("memory").warn("Failed to rebuild file memory store for incognito toggle", {
        code: "MEMORY_INCOGNITO_REBUILD_FAILED",
        cause: err as Error,
      });
      if (enabled) {
        // Fail closed: the user asked for incognito, so never leave the old
        // writable store in place when the replacement cannot be built.
        this.incognito = true;
        this.fileMemory = null;
        this.digest = null;
        this.memoryPromptIndex = null;
        this.memoryEnabled = false;
        this.memoryError = error;
      }
      return error;
    }
    this.incognito = enabled;
    this.fileMemory = nextStore;
    return null;
  }

  get promptDir(): string {
    return join(this.config.session.log_dir, this.id, "prompts");
  }

  getMemoryDbPath(): string | null {
    const configuredPath = this.config.memory?.db_path;
    if (configuredPath) {
      return resolveAgainstCwd(expandHome(configuredPath), this.cwd);
    }
    return resolveDefaultMemoryDbPath();
  }

  /** Successful file recall calls, including query and by-name reads. */
  getRecallUsedCount(): number {
    return this.eventLog.readAll().filter((event) => {
      if (event.kind !== "tool_result" || event.payload.tool !== "recall") return false;
      const result = event.payload.result as { ok?: boolean } | undefined;
      return result?.ok === true;
    }).length;
  }

  /** Track read_file paths for repeat-read scorecard signal (session-scoped digests). */
  trackScorecardFileRead(absPath: string, mtimeMs?: number, countAsRepeat = true): void {
    this.scorecard.trackReadPath(absPath, mtimeMs, countAsRepeat);
  }

  /** `null` when the scorecard read index is inactive — skip unread edit checks. */
  hasReadPath(absPath: string): boolean | null {
    if (!this.scorecard.isActive()) return null;
    return this.scorecard.hasReadPath(absPath);
  }

  listReadPaths(): string[] {
    return [];
  }

  recentWritesForPath(absPath: string): Array<{ path: string; turn?: number }> {
    const out: Array<{ path: string; turn?: number }> = [];
    const WRITE_TOOLS = new Set([
      "write_file",
      "edit_file",
      "batch_write",
      "batch_edit",
    ]);
    try {
      for (const ev of this.eventLog.readAll()) {
        if (ev.kind !== "tool_call") continue;
        const tool = ev.payload.tool ?? ev.payload.toolName;
        if (typeof tool !== "string" || !WRITE_TOOLS.has(tool)) continue;
        const args = ev.payload.args as Record<string, unknown> | undefined;
        if (!args) continue;
        const paths: string[] = [];
        if (typeof args.path === "string") paths.push(args.path);
        if (Array.isArray(args.files)) {
          for (const f of args.files) {
            if (
              f &&
              typeof f === "object" &&
              typeof (f as { path?: unknown }).path === "string"
            ) {
              paths.push((f as { path: string }).path);
            }
          }
        }
        if (Array.isArray(args.edits)) {
          for (const e of args.edits) {
            if (
              e &&
              typeof e === "object" &&
              typeof (e as { path?: unknown }).path === "string"
            ) {
              paths.push((e as { path: string }).path);
            }
          }
        }
        for (const p of paths) {
          const resolved = isAbsolute(p) ? p : resolve(this.cwd, p);
          if (resolved === absPath) out.push({ path: resolved });
        }
      }
    } catch {
      return [];
    }
    return out.slice(-5);
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

  getDisplayContextSnapshot(): ContextDisplaySnapshot | null {
    return this.displayContextSnapshot;
  }

  setDisplayContextSnapshot(snapshot: ContextDisplaySnapshot): void {
    this.displayContextSnapshot = snapshot;
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

  getMemoryPromptIndex(): { shown: number; total: number } | null {
    return this.memoryPromptIndex;
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

  /** Build a transcript for lifecycle callers and skill effectiveness tracking. */
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
  ): Promise<SessionEndStatus> {
    const summary = this.getSessionSummary();
    const emptyStatus = (memory: SessionEndStatus["memory"]): SessionEndStatus => ({
      memory,
      turns: summary.turns,
      stateObjects: summary.stateObjects,
      rememberCalls: summary.memoriesStored,
      recallUsed: 0,
      learningsStored: 0,
    });

    if (this.ended) return emptyStatus("skipped");
    this.ended = true;
    await this.hooks.runSessionEnd({ session: this, reason });
    try {
      await this.lspManager.shutdown();
    } catch (err) {
      this.getLogger().child("tool").warn("LSP shutdown failed", {
        cause: err as Error,
      });
    }

    const memoryStatus: SessionEndStatus["memory"] = this.memoryEnabled && this.fileMemory ? "noop" : "skipped";
    const recallUsedCount = this.getRecallUsedCount();

    if (this.contextEngine) {
      try {
        const engineConfig = resolveContextEngineConfig(this.config);
        if (this.debug || engineConfig.measurement_mode) {
          this.syncScorecardFromRuntime();
          const telemetrySummary = this.contextEngine.finalizeTelemetry(this.getTurnCount());
          this.getLogger().child("context_engine").debug(renderSessionTelemetrySummary(telemetrySummary));

          // Skills summary (issue #486 report card) — engine mode only
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

      // Workflow pattern tracking (issue #482): persist session pattern before
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

    }

    // Flush skill effectiveness (issue #467): update usefulness in skill_stats.
    // Engine mode only (skillRuntime is null in classic), before scorecard flush
    // so syncScorecardFromRuntime captures the real used count.
    if (this.skillRuntime && this.skillStatsStore) {
      try {
        const endEvents = events ?? this.getTranscriptEvents();
        const good = isSessionGood(reason, endEvents);
        const effects = this.skillRuntime.getSkillEffects();
        const cooc = this.skillRuntime.getCooccurrencePairs();
        this.skillStatsStore.flush(this.id, good, effects, cooc);
      } catch (err) {
        this.getLogger().child("skills").warn("Skill effectiveness flush failed", {
          cause: err as Error,
        });
      }
    }

    const contextEngineToClose = this.contextEngine;

    // Flush scorecard while the context DB is still open (shares connection with ContextEngine).
    try {
      this.syncScorecardFromRuntime();
      await this.scorecard.flush(undefined, recallUsedCount);
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
    return {
      memory: memoryStatus,
      turns: summary.turns,
      stateObjects: summary.stateObjects,
      rememberCalls: summary.memoriesStored,
      recallUsed: recallUsedCount,
      learningsStored: 0,
    };
  }

  private createFileMemory(incognito = this.incognito): FileMemoryStore {
    return createFileMemoryStore({
      home: dirname(appHomePath()),
      cwd: this.cwd,
      incognito,
    });
  }

  private async initFileMemory(): Promise<void> {
    if (!this.memoryEnabled) return;
    try {
      this.fileMemory = this.createFileMemory();
      const index = await this.fileMemory.buildMemoryIndex();
      this.digest = index.ok && index.total > 0 ? index.text : null;
      if (!index.ok) throw new Error(index.error);
      this.memoryPromptIndex = { shown: index.shown, total: index.total };
      this.memoryError = null;
      if (index.skippedScopes?.length) {
        this.getLogger().child("memory").warn("File memory scope skipped", {
          details: { skippedScopes: index.skippedScopes },
        });
      }
    } catch (err) {
      this.memoryError = memoryErrorMessage(err, appHomePath("memory"));
      this.getLogger().child("memory").warn("Failed to initialize file memory, continuing without memory", {
        code: "MEMORY_INIT_FAILED",
        cause: err as Error,
      });
      this.memoryEnabled = false;
      this.fileMemory = null;
      this.digest = null;
      this.memoryPromptIndex = null;
    }
  }

  private async initEmbedder(): Promise<void> {
    if (!this.config.memory.enabled) return;
    try {
      this.embedder = await createEmbedder(this.config.memory, { logger: this.getLogger() });
      this.embeddingBackend = resolveEmbeddingBackend(this.config.memory, this.embedder);
    } catch (err) {
      this.getLogger().child("context_engine").warn("Failed to initialize semantic scoring, continuing without embeddings", {
        cause: err as Error,
      });
      this.embedder = null;
    }
  }
}

// ---- Helpers ----

function initContextEngine(session: Session): void {
  const engineConfig = resolveContextEngineConfig(session.config);
  const measurementMode = engineConfig.measurement_mode;
  const scorecardOptions = {};

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
      findLastResetBoundaryTurn(session.eventLog.readAll()),
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

function expandHome(p: string): string {
  return p.startsWith("~/") ? p.replace(/^~\//, `${homedir()}/`) : p;
}

/** One-line user-facing reason for failed file memory initialization. */
function memoryErrorMessage(err: unknown, dbPath: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("EACCES") || msg.includes("permission")) {
    return "Cannot write to ~/.praana/. Check permissions or set PRAANA_HOME.";
  }
  return dbPath && !msg.includes(dbPath) ? `${msg} (${dbPath})` : msg;
}

/**
 * Shared marker for the AGENTS.md truncation notice. The producer
 * (session.ts) composes its log/capture lines from it and the consumer
 * (app-controller.ts) matches with `isAgentsTruncationNotice`, so a
 * rewording propagates to both sides.
 */
export const AGENTS_TRUNCATION_MARKER = "AGENTS.md content truncated";

/** App-log message emitted when project instructions are truncated. */
export const AGENTS_TRUNCATION_LOG_MESSAGE =
  `${AGENTS_TRUNCATION_MARKER} to ~4000 tokens`;

/** Capture-hook line produced for the truncation notice (TUI). */
export const AGENTS_TRUNCATION_LOG_LINE =
  `[session] ${AGENTS_TRUNCATION_LOG_MESSAGE}`;

/** True when `line` is a truncation notice produced by `loadAgentsContext`. */
export function isAgentsTruncationNotice(line: string): boolean {
  return line.includes(AGENTS_TRUNCATION_MARKER);
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
 *
 * When truncation happens, the notice is emitted through `opts.logger`
 * (the session logger, when provided) so one code path handles both the
 * TUI capture hook and the historical headless stderr write; the log-file
 * entry is kept either way.
 */
export function loadAgentsContext(
  cwd: string,
  opts?: {
    /** Logger that emits the truncation notice; defaults to the app logger. */
    logger?: PraanaLogger;
  },
): string | null {
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
    const details = { tokenEstimate: estimateTokens(combined) };
    // One code path: notice() keeps the log-file entry and routes stderr
    // through the capture hook (TUI) or the historical stderr write
    // (headless) depending on how the logger was configured.
    (opts?.logger ?? getAppLogger().child("session")).notice(
      AGENTS_TRUNCATION_LOG_MESSAGE,
      { details },
    );
    return `${combined.slice(0, MAX_CHARS)}\n\n<!-- [truncated] -->`;
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

  // Initialize SkillStatsStore for both engine and classic modes (read path;
  // write path / flush only fires from engine mode at session end).
  try {
    const memPath = session.getMemoryDbPath();
    const projectScope = `context:${hashString(findGitRoot(cwd))}`;
    session.skillStatsStore = new SkillStatsStore(memPath, projectScope);
    session.skillUsefulness = session.skillStatsStore.loadUsefulness();
  } catch (err) {
    session.getLogger().child("skills").warn("Failed to load skill usefulness, continuing without ranking", {
      cause: err as Error,
    });
    session.skillStatsStore = null;
    session.skillUsefulness = null;
  }

  if (session.skills.length > 0) {
    session.getLogger().child("skills").notice(`${session.skills.length} skill(s)`);
  }
}
