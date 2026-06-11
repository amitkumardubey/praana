import { resolve } from "node:path";
import type { AriaConfig } from "./types.js";
import type { CliArgs } from "./cli-args.js";
import { Session } from "./session.js";
import { runTurn } from "./turn.js";
import { TurnController } from "./turn-control.js";
import { buildStatusBarInput } from "./status-bar.js";
import type { StatusBarInput } from "./status-bar.js";
import { executeSlashCommand, type SlashCommandResult } from "./slash-commands.js";
import type { TurnUiSink } from "./ui-events.js";
import { createDefaultTurnSink } from "./ui-events.js";
import {
  formatRecentConversationLines,
  formatSessionBannerLines,
} from "./app-banner.js";

export interface StartupInfo {
  session: Session;
  cwd: string;
  model: string;
  bannerLines: string[];
  recentConversationLines: string[];
  isResume: boolean;
}

export class AppController {
  session!: Session;
  readonly cwd: string;
  readonly config: AriaConfig;
  readonly parsed: CliArgs;
  showThinking = true;
  currentModel?: string;
  sessionEnded = false;

  private readonly turnController = new TurnController();
  private interruptHandling = false;

  constructor(opts: { cwd?: string; config: AriaConfig; parsed: CliArgs }) {
    this.cwd = opts.cwd ?? resolve(process.cwd());
    this.config = opts.config;
    this.parsed = opts.parsed;
  }

  async start(): Promise<StartupInfo> {
    const { sessionId, resumeMode, debug } = this.parsed;

    if (resumeMode && sessionId) {
      this.session = await Session.resume(sessionId, this.cwd, this.config);
      this.session.debug = debug;
    } else {
      this.session = await Session.create(this.cwd, this.config, {
        incognito: this.parsed.incognito,
      });
      this.session.debug = debug;
    }

    this.currentModel = this.session.getModelOverride() ?? undefined;
    const model = this.currentModelOrDefault();

    return {
      session: this.session,
      cwd: this.cwd,
      model,
      bannerLines: formatSessionBannerLines(this.session, this.cwd, model),
      recentConversationLines: resumeMode
        ? formatRecentConversationLines(this.session)
        : [],
      isResume: !!resumeMode,
    };
  }

  currentModelOrDefault(): string {
    return this.currentModel ?? this.session.config.llm.model;
  }

  getStatusBarInput(): StatusBarInput {
    return buildStatusBarInput(this.session, {
      model: this.currentModelOrDefault(),
      debug: this.session.debug,
      thinking: this.showThinking,
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

    try {
      await runTurn(this.session, input, this.currentModel, {
        signal,
        sink: uiSink,
        onTextDelta: (delta) => {
          stopSpinnerOnce();
          uiSink.onTextDelta?.(delta);
        },
        onThinkingDelta: (delta) => {
          stopSpinnerOnce();
          uiSink.onThinkingDelta?.(delta);
        },
        onToolCallsStart: () => {
          uiSink.onToolCallsStart?.();
        },
      });
      stopSpinnerOnce();
    } finally {
      this.turnController.end();
    }
  }

  async shutdown(): Promise<void> {
    if (this.sessionEnded) return;
    this.sessionEnded = true;
    const events = this.session.getTranscriptEvents();
    await this.session.end("clean", events, { memoryTimeoutMs: 5_000 });
  }
}
