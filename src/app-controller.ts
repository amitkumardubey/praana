import { resolve } from "node:path";
import type { PraanaConfig } from "./types.js";
import type { CliArgs } from "./cli-args.js";
import { Session, type SessionEndStatus } from "./session.js";
import { runTurn } from "./turn.js";
import { TurnController } from "./turn-control.js";
import { buildStatusBarInput, type StatusBarInput } from "./status-bar.js";
import { executeSlashCommand, type SlashCommandResult } from "./slash-commands.js";
import { createDefaultTurnSink, type TurnUiSink } from "./ui-events.js";
import {
  formatRecentConversationLines,
  formatSessionBannerLines,
} from "./app-banner.js";
import { buildTranscriptFromEvents, type TranscriptEntry } from "./ui/tui/transcript/model.js";

export interface StartupInfo {
  session: Session;
  cwd: string;
  model: string;
  bannerLines: string[];
  recentConversationLines: string[];
  /** Full transcript entries rebuilt from event log on resume (TUI). */
  transcriptBootstrap: TranscriptEntry[];
  isResume: boolean;
}

export class AppController {
  session!: Session;
  readonly cwd: string;
  readonly config: PraanaConfig;
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

    if (resumeMode && sessionId) {
      this.session = await Session.resume(sessionId, this.cwd, this.config, {
        captureNotice,
      });
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
      bannerLines: formatSessionBannerLines(this.session, this.cwd, model),
      recentConversationLines: resumeMode
        ? formatRecentConversationLines(this.session)
        : [],
      transcriptBootstrap: resumeMode
        ? buildTranscriptFromEvents(this.session.eventLog.readAll(), {
            useUnicode: this.config.ui.tool_icons === "unicode",
          })
        : [],
      isResume: !!resumeMode,
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

  handleUserInterrupt(onPromptExit?: () => void): "abort_turn" | "prompt_exit" | "noop" {
    if (this.interruptHandling) return "noop";
    this.interruptHandling = true;
    setImmediate(() => {
      this.interruptHandling = false;
    });

    if (this.turnController.isActive()) {
      this.turnController.abort();
      return "abort_turn";
    }

    onPromptExit?.();
    return "prompt_exit";
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
      onToolCall: (name, args) => uiSink.onToolCall?.(name, args),
      onToolResult: (name, text, isError) => uiSink.onToolResult?.(name, text, isError),
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
    } finally {
      this.turnController.end();
    }
  }

  async shutdown(): Promise<ShutdownStatus> {
    if (this.sessionEnded) return { memory: "noop" };
    this.sessionEnded = true;
    const events = this.session.getTranscriptEvents();
    const memoryTimeoutMs =
      this.config.session.shutdown_memory_timeout_ms ?? 2_000;
    return this.session.end("clean", events, { memoryTimeoutMs });
  }
}

export type ShutdownStatus = {
  memory: SessionEndStatus["memory"] | "noop";
};
