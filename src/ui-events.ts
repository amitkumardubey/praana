import {
  printDebug,
  printDebugBlock,
  printMemoryBanner,
  printToolCall,
  startSpinner,
  stopSpinner,
} from "./ui.js";
import type { LogEntry } from "./logger.js";
import type { MemoryBannerStats } from "./turn.js";
export type { MemoryBannerStats };

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
    onError: (entry) => {
      if (entry.level === "error" || entry.level === "warn") {
        process.stderr.write(`[${entry.domain}] ${entry.message}\n`);
      }
    },
  };
}

export function hasTurnUiSink(sink?: TurnUiSink): sink is TurnUiSink {
  return sink !== undefined;
}
