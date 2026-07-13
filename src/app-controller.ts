import { resolve } from "node:path";
import type { PraanaConfig } from "./types.js";
import type { CliArgs } from "./cli-args.js";
import { loadConfig } from "./config.js";
import { Session, type SessionEndStatus } from "./session.js";
import { findLatestSessionForCwd } from "./event-log.js";
import { runTurn } from "./turn.js";
import { TurnController, TurnAbortedError } from "./turn-control.js";
import { buildStatusBarInput, type StatusBarInput } from "./status-bar.js";
import { executeSlashCommand, type SlashCommandResult } from "./slash-commands.js";
import { createDefaultTurnSink, type TurnUiSink } from "./ui-events.js";
import {
  formatRecentConversationLines,
  formatSessionBannerLines,
} from "./app-banner.js";
import { buildTranscriptFromEvents, type TranscriptEntry } from "./ui/tui/transcript/model.js";
import { eventsAfterResetBoundary } from "./event-log.js";

export interface StartupInfo {
  session: Session;
  cwd: string;
  model: string;
  bannerLines: string[];
  recentConversationLines: string[];
  /** Full transcript entries rebuilt from event log on resume (TUI). */
  transcriptBootstrap: TranscriptEntry[];
  isResume: boolean;
  /** Shown at startup (e.g. bare resume fell back to a new session). */
  startupNotices: string[];
}

export class AppController {
  session!: Session;
  readonly cwd: string;
  /** Active config. Not readonly: `startNewSession()` reloads it from disk on /new. Re-read after /new rather than caching. */
  config: PraanaConfig;
  readonly parsed: CliArgs;
  showThinking = false;
  currentModel?: string;
  sessionEnded = false;

  private readonly turnController = new TurnController();
  private interruptHandling = false;

  constructor(opts: { cwd?: string; config: PraanaConfig; parsed: CliArgs }) {
    this.cwd = opts.cwd ?? resolve(process.cwd());
    this.config = opts.config;
    this.parsed = opts.parsed;
  }

  async start(): Promise<StartupInfo> {
    const { sessionId, resumeMode, debug } = this.parsed;
    const captureNotice = (_line: string) => {};
    const startupNotices: string[] = [];
    let didResume = false;

    if (resumeMode) {
      const resolvedId =
        sessionId ?? findLatestSessionForCwd(this.config.session.log_dir, this.cwd);
      if (resolvedId) {
        this.session = await Session.resume(resolvedId, this.cwd, this.config, {
          captureNotice,
        });
        didResume = true;
      } else if (sessionId) {
        this.session = await Session.resume(sessionId, this.cwd, this.config, {
          captureNotice,
        });
        didResume = true;
      } else {
        startupNotices.push(`No session found for this directory: ${this.cwd}`);
        startupNotices.push("Starting a new session.");
        this.session = await Session.create(this.cwd, this.config, {
          incognito: this.parsed.incognito,
          captureNotice,
        });
      }
      if (didResume) {
        const staleTasks = this.session.getStaleTasks?.() ?? [];
        if (staleTasks.length > 0) {
          const titles = staleTasks
            .map((t) => (t.payload as { title?: string }).title ?? "untitled")
            .join("', '");
          startupNotices.push(
            `⚠ Resumed with stale active task${staleTasks.length === 1 ? "" : "s"}: '${titles}'. Confirm scope before continuing or starting a new task.`,
          );
        }
      }
      this.session.debug = debug;
    } else {
      this.session = await Session.create(this.cwd, this.config, {
        incognito: this.parsed.incognito,
        captureNotice,
      });
      this.session.debug = debug;
    }

    this.currentModel = this.session.getModelOverride() ?? undefined;
    const model = this.session.getActiveModelLabel();

    return {
      session: this.session,
      cwd: this.cwd,
      model,
      bannerLines: [
        ...formatSessionBannerLines(this.session, this.cwd, model),
        ...(this.session.memoryInitError
          ? [`⚠ memory disabled: ${this.session.memoryInitError}`]
          : []),
      ],
      recentConversationLines: didResume
        ? formatRecentConversationLines(this.session)
        : [],
      transcriptBootstrap: didResume
        ? buildTranscriptFromEvents(
            eventsAfterResetBoundary(this.session.eventLog.readAll()),
            {
              useUnicode: this.config.ui.tool_icons === "unicode",
            },
          )
        : [],
      isResume: didResume,
      startupNotices,
    };
  }

  currentModelOrDefault(): string {
    return this.currentModel ?? this.session.getActiveModelId();
  }

  getStatusBarInput(): StatusBarInput {
    const model = this.session.getActiveModelLabel();
    const modelId = this.currentModelOrDefault();
    return buildStatusBarInput(this.session, {
      model,
      debug: this.session.debug,
      thinking: this.showThinking,
      contextWindowTokens: this.session.getContextWindowTokens(modelId),
    });
  }

  isTurnActive(): boolean {
    return this.turnController.isActive();
  }

  abortTurn(): void {
    this.turnController.abort();
  }

  /**
   * Resolve a user interrupt (Ctrl+C / Esc Esc) into one of three actions:
   *  - "abort_turn"  — a turn is running: interrupt the agent, return to prompt
   *  - "exit"        — idle and the input box is empty: quit the app
   *  - "clear_input" — idle and the input box has text: clear it
   *  - "noop"        — a repeat interrupt inside the debounce window (ignored)
   *
   * `inputIsEmpty` reflects whether the TUI input box currently has text. It is
   * only consulted when no turn is active.
   */
  handleUserInterrupt(
    inputIsEmpty: boolean,
  ): "abort_turn" | "clear_input" | "exit" | "noop" {
    if (this.interruptHandling) return "noop";
    this.interruptHandling = true;
    setImmediate(() => {
      this.interruptHandling = false;
    });

    if (this.turnController.isActive()) {
      this.turnController.abort();
      return "abort_turn";
    }

    return inputIsEmpty ? "exit" : "clear_input";
  }

  async executeSlashCommand(input: string): Promise<SlashCommandResult> {
    return executeSlashCommand(input, this.session, {
      setModel: (m) => {
        this.currentModel = m;
      },
      setThinking: (v) => {
        this.showThinking = v;
      },
      getThinking: () => this.showThinking,
      isTurnActive: () => this.isTurnActive(),
    });
  }

  async runUserTurn(input: string, sink?: TurnUiSink): Promise<void> {
    const uiSink = sink ?? createDefaultTurnSink();
    const signal = this.turnController.begin();

    uiSink.onSpinnerStart?.("thinking…");
    let spinnerStopped = false;
    const stopSpinnerOnce = () => {
      if (spinnerStopped) return;
      uiSink.onSpinnerStop?.();
      spinnerStopped = true;
    };

    // Do NOT use `{ ...uiSink }` — uiSink may be a class instance (PiTuiSink)
    // whose methods live on the prototype, not as own properties, so spread
    // silently drops onToolCall, onToolResult, onMemoryBanner, onError, etc.
    // Build an explicit delegate that forwards every TurnUiSink member.
    const wrappedSink: TurnUiSink = {
      shellLiveStream: uiSink.shellLiveStream,
      onTextDelta: (delta) => { stopSpinnerOnce(); uiSink.onTextDelta?.(delta); },
      onThinkingDelta: (delta) => { stopSpinnerOnce(); uiSink.onThinkingDelta?.(delta); },
      onToolCallsStart: () => uiSink.onToolCallsStart?.(),
      onToolCall: (id, name, args) => uiSink.onToolCall?.(id, name, args),
      onToolResult: (id, name, text, isError) => uiSink.onToolResult?.(id, name, text, isError),
      onProviderUsage: (update) => uiSink.onProviderUsage?.(update),
      onTurnContextBaseline: (snapshot) => uiSink.onTurnContextBaseline?.(snapshot),
      onContextHistoryDelta: (delta) => uiSink.onContextHistoryDelta?.(delta),
      onTurnContextCommit: (snapshot) => uiSink.onTurnContextCommit?.(snapshot),
      onContextPreview: (snapshot) => uiSink.onContextPreview?.(snapshot),
      getContextPreview: () => uiSink.getContextPreview?.() ?? null,
      onDebug: (msg) => uiSink.onDebug?.(msg),
      onDebugBlock: (step, calls, results) => uiSink.onDebugBlock?.(step, calls, results),
      onMemoryBanner: (stats) => uiSink.onMemoryBanner?.(stats),
      onSpinnerStart: (text) => uiSink.onSpinnerStart?.(text),
      onSpinnerStop: () => uiSink.onSpinnerStop?.(),
      onNewline: () => uiSink.onNewline?.(),
      onFallback: (text) => uiSink.onFallback?.(text),
      onSystemLines: (lines) => uiSink.onSystemLines?.(lines),
      onError: (entry) => uiSink.onError?.(entry),
      flushText: () => uiSink.flushText?.(),
      consumeTurnStats: () => uiSink.consumeTurnStats?.() ?? null,
    };

    try {
      await runTurn(this.session, input, this.currentModel, {
        signal,
        sink: wrappedSink,
      });
      stopSpinnerOnce();
    } catch (err) {
      // A turn abort (Ctrl+C / Esc Esc) throws TurnAbortedError *after*
      // finalizeInterruptedTurn has already appended the partial response,
      // incremented the turn count, and persisted state. Swallow it so the
      // caller (the TUI) returns to the prompt instead of dying on an
      // unhandled rejection.
      if (err instanceof TurnAbortedError) return;
      throw err;
    } finally {
      this.turnController.end();
    }
  }

  /**
   * End the current session and start a fresh one with reloaded config.
   * The old session's memory summarizer is given a very short timeout so it
   * continues in the background; the rest of session shutdown is awaited.
   *
   * Atomicity: the old session is ended first. If config reload or the new
   * session creation then throws, the controller is rolled back to a usable
   * state — `this.session` is set to a fresh session created from the *old*
   * config so the user can continue typing instead of being stuck. The thrown
   * error is re-raised after rollback so the TUI can surface it.
   *
   * Memory DB safety: the old session's MemoryStore handle is not explicitly
   * closed (the background summarizer may still be writing). The new session
   * opens a second connection to the same `~/.praana/memory.db`. SQLite WAL
   * mode + busy_timeout makes this concurrent access safe for the brief
   * overlap window; the old handle is released by GC once the summarizer drains.
   */
  async startNewSession(): Promise<StartupInfo> {
    if (!this.sessionEnded) {
      const events = this.session.getTranscriptEvents();
      await this.session.end("clean", events, { memoryTimeoutMs: 50 });
      this.sessionEnded = true;
    }

    let newConfig: PraanaConfig;
    try {
      newConfig = loadConfig(this.parsed.configPath);
    } catch (err) {
      this.rollbackToFreshSession(this.config);
      throw err;
    }

    try {
      this.config = newConfig;
      this.session = await Session.create(this.cwd, newConfig, {
        incognito: this.parsed.incognito,
        captureNotice: () => {},
      });
      this.session.debug = this.parsed.debug;
      this.sessionEnded = false;
      this.currentModel = this.session.getModelOverride() ?? undefined;
    } catch (err) {
      // Roll back to a working session using the last known-good config so the
      // user isn't stuck with an ended session and no editor.
      this.rollbackToFreshSession(this.config);
      throw err;
    }

    const model = this.session.getActiveModelLabel();
    return {
      session: this.session,
      cwd: this.cwd,
      model,
      bannerLines: formatSessionBannerLines(this.session, this.cwd, model),
      recentConversationLines: [],
      transcriptBootstrap: [],
      isResume: false,
      startupNotices: [],
    };
  }

  /**
   * Recover from a failed /new by creating a fresh session from `config`.
   * Marks sessionEnded=false so shutdown() can end it cleanly later. Any error
   * here is swallowed — the original failure is more useful to the caller.
   */
  private async rollbackToFreshSession(config: PraanaConfig): Promise<void> {
    try {
      this.session = await Session.create(this.cwd, config, {
        incognito: this.parsed.incognito,
        captureNotice: () => {},
      });
      this.session.debug = this.parsed.debug;
      this.sessionEnded = false;
      this.currentModel = this.session.getModelOverride() ?? undefined;
    } catch {
      // Best-effort; caller will surface the original error.
    }
  }


  async shutdown(): Promise<ShutdownStatus> {
    if (this.sessionEnded || !this.session) {
      return {
        memory: "noop",
        turns: 0,
        stateObjects: 0,
        rememberCalls: 0,
        recallUsed: 0,
        learningsStored: 0,
      };
    }
    this.sessionEnded = true;
    const events = this.session.getTranscriptEvents();
    const memoryTimeoutMs =
      this.config.session.shutdown_memory_timeout_ms ?? 2_000;
    return this.session.end("clean", events, { memoryTimeoutMs });
  }
}

export type ShutdownStatus = Omit<SessionEndStatus, "memory"> & {
  memory: SessionEndStatus["memory"] | "noop";
};
