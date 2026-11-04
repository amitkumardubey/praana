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
   * continue, `false` to stop with a wrap-up summary. Absent ⇒ the turn uses
   * `max_steps` as a hard cap (last batch executes, then a wrap-up) and never pauses.
   */
  onStepPause?(stepsUsed: number, signal: AbortSignal): boolean | Promise<boolean>;
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
    ...(process.stdin.isTTY && process.stdout.isTTY
      ? { onStepPause: (stepsUsed: number, signal: AbortSignal) => promptContinueSteps(stepsUsed, signal) }
      : {}),
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
 * Plain-terminal soft pause (createDefaultTurnSink). Enter, y, or yes
 * continues; anything else stops with a wrap-up. Readline has no Esc
 * handling here. Non-TTY stdin never prompts.
 */
async function promptContinueSteps(stepsUsed: number, signal: AbortSignal): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  if (signal.aborted) return false;
  const wasFlowing = process.stdin.readableFlowing;
  // Drop a leftover auto-resume hook before readline attaches its own listeners.
  clearResumeOnConsumer();
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let settled = false;
    const finish = (answer: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rl.close();
      restoreStdinFlow(wasFlowing);
      resolve(answer);
    };
    const onAbort = () => finish("no");
    signal.addEventListener("abort", onAbort, { once: true });
    rl.once("close", () => finish("no"));
    rl.question(
      `Used ${stepsUsed} steps this turn. Continue? Enter or y = continue, anything else = stop `,
      { signal },
      finish,
    );
  });
  const normalized = answer.trim().toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}

/**
 * Readline pauses its input when the prompt closes. Resume only a stream
 * that was already flowing, and pause only one that was already paused.
 * An untouched stream (`readableFlowing === null`) must start again when a
 * consumer attaches. Adding and removing a `data` listener does not put
 * `readableFlowing` back to null (Node v24.22.1 and Bun 1.4.4), so a
 * one-time `newListener` hook resumes on `data` and leaves `readable` in
 * paused mode. The hook is removed before the next prompt so readline's
 * own listeners do not trip it.
 */
let syntheticUntouched: NodeJS.ReadStream | null = null;
let resumeOnConsumer: ((event: string | symbol) => void) | null = null;
let resumeOnConsumerStdin: NodeJS.ReadStream | null = null;

function clearResumeOnConsumer(): void {
  if (resumeOnConsumer && resumeOnConsumerStdin) {
    resumeOnConsumerStdin.removeListener("newListener", resumeOnConsumer);
  }
  resumeOnConsumer = null;
  resumeOnConsumerStdin = null;
}

function restoreStdinFlow(wasFlowing: boolean | null): void {
  const stdin = process.stdin;
  clearResumeOnConsumer();
  const untouched = wasFlowing === null || (wasFlowing === false && syntheticUntouched === stdin);
  syntheticUntouched = null;
  if (wasFlowing === true) {
    stdin.resume();
    return;
  }
  if (!untouched) {
    stdin.pause();
    return;
  }
  stdin.pause();
  syntheticUntouched = stdin;
  const arm = (event: string | symbol) => {
    if (event !== "data" && event !== "readable") return;
    clearResumeOnConsumer();
    syntheticUntouched = null;
    // `newListener` runs before the consumer is added. `resume()` flows on
    // the next turn, so a `data` listener is attached before the chunk.
    // A `readable` consumer pulls from the paused stream and must not be resumed.
    if (event === "data") stdin.resume();
  };
  resumeOnConsumer = arm;
  resumeOnConsumerStdin = stdin;
  stdin.on("newListener", arm);
}

export function hasTurnUiSink(sink?: TurnUiSink): sink is TurnUiSink {
  return sink !== undefined;
}
