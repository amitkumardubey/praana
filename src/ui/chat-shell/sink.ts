import type { TurnUiSink, MemoryBannerStats } from "../../ui-events.js";
import type { TranscriptAction } from "./reducer.js";

const THROTTLE_MS = 50;

function createThrottledDispatcher(
  dispatch: (action: TranscriptAction) => void
): {
  onDelta: (delta: string) => void;
  flush: () => void;
} {
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushBuffer = () => {
    if (buffer) {
      dispatch({ type: "assistant_delta", delta: buffer });
      buffer = "";
    }
    timer = null;
  };

  const onDelta = (delta: string) => {
    buffer += delta;
    if (!timer) {
      timer = setTimeout(flushBuffer, THROTTLE_MS);
    }
  };

  return { onDelta, flush: flushBuffer };
}

export function createChatSink(
  dispatch: (action: TranscriptAction) => void
): TurnUiSink {
  const text = createThrottledDispatcher(dispatch);
  let pendingStats: MemoryBannerStats | null = null;

  return {
    shellLiveStream: false,
    onTextDelta: (delta) => text.onDelta(delta),
    onThinkingDelta: (delta) => {
      dispatch({ type: "thinking_delta", delta });
    },
    onToolCallsStart: () => {
      text.flush();
      dispatch({ type: "thinking_close" });
    },
    onToolCall: (toolName, args) => {
      text.flush();
      dispatch({ type: "tool_call", toolName, args });
    },
    onToolResult: (toolName, resultText, isError) => {
      text.flush();
      dispatch({ type: "tool_result", toolName, resultText, isError });
    },
    flushText: () => text.flush(),
    consumeTurnStats: () => {
      const stats = pendingStats;
      pendingStats = null;
      return stats;
    },
    onDebug: (message) => {
      dispatch({ type: "system_lines", lines: [`[debug] ${message}`] });
    },
    onDebugBlock: (stepIndex, toolCalls, toolResults) => {
      const lines = [`[debug] step ${stepIndex} tools`];
      for (const tc of toolCalls) {
        lines.push(`  > ${tc.toolName}(${JSON.stringify(tc.args).slice(0, 120)})`);
      }
      for (const tr of toolResults) {
        lines.push(`  < ${tr.toolName}`);
      }
      dispatch({ type: "system_lines", lines });
    },
    onMemoryBanner: (stats) => {
      pendingStats = stats;
    },
    onSpinnerStart: () => {},
    onSpinnerStop: () => {},
    onNewline: () => {
      dispatch({ type: "assistant_delta", delta: "\n" });
    },
    onFallback: (text) => {
      dispatch({ type: "assistant_delta", delta: text + "\n" });
    },
    onSystemLines: (lines) => {
      dispatch({ type: "system_lines", lines });
    },
    onError: (entry) => {
      dispatch({
        type: "system_lines",
        lines: [`[${entry.level}] ${entry.domain}: ${entry.message}`],
      });
    },
  };
}
