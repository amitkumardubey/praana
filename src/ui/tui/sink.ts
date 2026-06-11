import type { Dispatch } from "react";
import type { TurnUiSink } from "../../ui-events.js";
import type { TranscriptAction } from "./reducer.js";
import { formatMemoryBannerLine } from "./reducer.js";

export function createTuiTurnSink(
  dispatch: Dispatch<TranscriptAction>
): TurnUiSink {
  return {
    onTextDelta: (delta) => {
      dispatch({ type: "assistant_delta", delta });
    },
    onThinkingDelta: (delta) => {
      dispatch({ type: "thinking_delta", delta });
    },
    onToolCallsStart: () => {
      dispatch({ type: "thinking_close" });
    },
    onToolCall: (toolName, args) => {
      dispatch({ type: "tool_call", toolName, args });
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
      const text = formatMemoryBannerLine(stats);
      if (text) dispatch({ type: "memory_banner", text });
    },
    onSpinnerStart: () => {
      /* busy state handled by turn wrapper */
    },
    onSpinnerStop: () => {
      /* noop */
    },
    onNewline: () => {
      dispatch({ type: "assistant_delta", delta: "\n" });
    },
    onFallback: (text) => {
      dispatch({ type: "assistant_delta", delta: text + "\n" });
    },
  };
}
