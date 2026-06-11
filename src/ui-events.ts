import {
  printDebug,
  printDebugBlock,
  printMemoryBanner,
  printToolCall,
  startSpinner,
  stopSpinner,
} from "./ui.js";
import type { computeMemoryStats } from "./turn.js";

export type MemoryBannerStats = ReturnType<typeof computeMemoryStats>;

/** UI sink for turn execution — replaces direct stdout/stderr writes when provided. */
export interface TurnUiSink {
  onTextDelta?(delta: string): void;
  onThinkingDelta?(delta: string): void;
  onToolCallsStart?(): void;
  onToolCall?(toolName: string, args: Record<string, unknown>): void;
  onDebug?(message: string): void;
  onDebugBlock?(
    stepIndex: number,
    toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
    toolResults: Array<{ toolName: string; result: unknown }>
  ): void;
  onMemoryBanner?(stats: MemoryBannerStats): void;
  onSpinnerStart?(text: string): void;
  onSpinnerStop?(): void;
  onNewline?(): void;
  onFallback?(text: string): void;
}

/** Default sink: streaming callbacks + legacy terminal helpers. */
export function createDefaultTurnSink(options?: {
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCallsStart?: () => void;
}): TurnUiSink {
  return {
    onTextDelta: (delta) => {
      if (options?.onTextDelta) options.onTextDelta(delta);
      else process.stdout.write(delta);
    },
    onThinkingDelta: (delta) => options?.onThinkingDelta?.(delta),
    onToolCallsStart: () => options?.onToolCallsStart?.(),
    onToolCall: (toolName, args) => printToolCall(toolName, args),
    onDebug: (message) => printDebug(message),
    onDebugBlock: (stepIndex, toolCalls, toolResults) =>
      printDebugBlock(stepIndex, toolCalls, toolResults),
    onMemoryBanner: (stats) => printMemoryBanner(stats),
    onSpinnerStart: (text) => startSpinner(text),
    onSpinnerStop: () => stopSpinner(),
    onNewline: () => process.stdout.write("\n"),
    onFallback: (text) => process.stdout.write(text + "\n"),
  };
}

export function hasTurnUiSink(sink?: TurnUiSink): sink is TurnUiSink {
  return sink !== undefined;
}
