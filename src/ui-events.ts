import {
  printDebug,
  printDebugBlock,
  printMemoryBanner,
  printToolCall,
  startSpinner,
  stopSpinner,
} from "./ui.js";
import { createInterface } from "node:readline";
import type { LogEntry } from "./logger.js";
import type { ContextDisplaySnapshot, ContextHistoryDelta } from "./context-display.js";
import type { MemoryBannerStats, ProviderUsageUpdate } from "./turn.js";
export type { MemoryBannerStats, ProviderUsageUpdate } from "./turn.js";
export type { ContextDisplaySnapshot, ContextHistoryDelta } from "./context-display.js";

/** UI sink for turn execution — replaces direct stdout/stderr writes when provided. */
export interface TurnUiSink {
  /** When false, shell tool buffers output only (no raw terminal writes). Default: true. */
  shellLiveStream?: boolean;
  onTextDelta?(delta: string): void;
  onThinkingDelta?(delta: string): void;
  onToolCallsStart?(): void;
  onToolCall?(toolCallId: string, toolName: string, args: Record<string, unknown>): void;
  /** Notify UI of the raw tool result text for rendering as a distinct block. */
  onToolResult?(toolCallId: string, toolName: string, resultText: string, isError?: boolean): void;
  /** Fired after each LLM step when the provider reports token usage. */
  onProviderUsage?(update: ProviderUsageUpdate): void;
  /** Baseline context snapshot after compile (system prompt + user input). */
  onTurnContextBaseline?(snapshot: ContextDisplaySnapshot): void;
  /** In-turn history growth (assistant message or distilled tool result). */
  onContextHistoryDelta?(delta: ContextHistoryDelta): void;
  /** Final context snapshot committed at turn end. */
  onTurnContextCommit?(snapshot: ContextDisplaySnapshot): void;
  /** Live preview for glance bar (engine mode monotonic updates). */
  onContextPreview?(snapshot: ContextDisplaySnapshot): void;
  /** Current in-turn or last-committed context preview (TUI sink). */
  getContextPreview?(): ContextDisplaySnapshot | null;
  onDebug?(message: string): void;
  onDebugBlock?(
    stepIndex: number,
    toolCalls: Array<{ toolCallId?: string; toolName: string; args: Record<string, unknown> }>,
    toolResults: Array<{ toolCallId?: string; toolName: string; result: unknown }>
  ): void;
  onMemoryBanner?(stats: MemoryBannerStats): void;
  onSpinnerStart?(text: string): void;
  onSpinnerStop?(): void;
  onNewline?(): void;
  onFallback?(text: string): void;
  /** System lines for informational messages (e.g., step limit warnings). */
  onSystemLines?(lines: string[]): void;
  /**
   * Interactive soft-pause: called before a tool batch executes when this turn
   * has used a multiple of `turn.pause_after_steps` steps. Resolve `true` to
   * continue, `false` to stop with a wrap-up summary. Absent ⇒ never pause
   * (headless / non-interactive sinks).
   */
  onStepPause?(stepsUsed: number): boolean | Promise<boolean>;
  /** Slash command result output to display in a distinct overlay. */
  onSlashCommandResult?(lines: string[]): void;
  /** Structured error for UI display (LLM failures, etc.). */
  onError?(entry: LogEntry): void;
  /** Flush any buffered text before dispatching terminal actions (e.g. assistant_complete).
   *  Used by throttled sinks to ensure no text is lost. */
  flushText?(): void;
  /** Take buffered turn stats for the combined turn footer line. */
  consumeTurnStats?(): MemoryBannerStats | null;
}

/** Default sink: streaming callbacks + legacy terminal helpers. */
export function createDefaultTurnSink(options?: {
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCallsStart?: () => void;
}): TurnUiSink {
  return {
    shellLiveStream: true,
    onTextDelta: (delta) => {
      if (options?.onTextDelta) options.onTextDelta(delta);
      else process.stdout.write(delta);
    },
    onThinkingDelta: (delta) => options?.onThinkingDelta?.(delta),
    onToolCallsStart: () => options?.onToolCallsStart?.(),
    onToolCall: (_toolCallId, toolName, args) => printToolCall(toolName, args),
    onToolResult: () => {
      /* terminal mode doesn't need a separate result block; it streams naturally */
    },
    onProviderUsage: undefined,
    onDebug: (message) => printDebug(message),
    onDebugBlock: (stepIndex, toolCalls, toolResults) =>
      printDebugBlock(stepIndex, toolCalls, toolResults),
    onMemoryBanner: (stats) => printMemoryBanner(stats),
    onSpinnerStart: (text) => startSpinner(text),
    onSpinnerStop: () => stopSpinner(),
    onNewline: () => process.stdout.write("\n"),
    onFallback: (text) => process.stdout.write(text + "\n"),
    onSystemLines: (lines) => {
      for (const line of lines) {
        process.stdout.write(line + "\n");
      }
    },
    onStepPause: (stepsUsed) => promptContinueSteps(stepsUsed),
    onSlashCommandResult: (lines) => {
      for (const line of lines) {
        process.stdout.write(line + "\n");
      }
    },
    onError: (entry) => {
      if (entry.level === "error" || entry.level === "warn") {
        process.stderr.write(`[${entry.domain}] ${entry.message}\n`);
      }
    },
  };
}

/**
 * Plain-terminal soft pause (createDefaultTurnSink). Enter continues; any
 * other key (e.g. Esc) stops with a wrap-up. Non-TTY stdin never prompts.
 */
async function promptContinueSteps(stepsUsed: number): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(
      `Used ${stepsUsed} steps this turn. Continue? [Enter=continue, Esc=stop] `,
      (ans) => {
        rl.close();
        resolve(ans);
      },
    );
  });
  return answer.trim() === "";
}

export function hasTurnUiSink(sink?: TurnUiSink): sink is TurnUiSink {
  return sink !== undefined;
}
