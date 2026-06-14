import { summarizeArgs } from "../../tool-summary.js";
import type { MemoryBannerStats } from "../../ui-events.js";
import {
  formatToolDisplay,
  formatTurnFooter,
  formatShellOutputForDisplay,
  summarizeResultForDisplay,
} from "./tool-display.js";

export type TranscriptRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "thinking"
  | "tool_result"
  | "turn_footer";

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  text: string;
  toolName?: string;
  /** Compact result summary attached to a tool entry */
  resultSummary?: string;
  isError?: boolean;
  /** Raw result text for error detail */
  resultText?: string;
  /** Multiline shell output body for TUI display */
  resultBody?: string;
  /** Display icon for tool rows */
  toolIcon?: string;
  /** Human-readable tool label */
  toolLabel?: string;
  /** Pending verb while tool is running */
  toolPending?: string;
  /** Group ID for visual turn grouping — increments on each user message */
  group: number;
  /** Epoch ms when live thinking started */
  thinkingStartedAt?: number;
  /** Elapsed thinking time once completed */
  durationMs?: number;
}

export interface TranscriptState {
  completed: TranscriptEntry[];
  live: TranscriptEntry | null;
  nextId: number;
  liveKind: "assistant" | "thinking" | null;
  busy: boolean;
  groupCounter: number;
}

export type TranscriptAction =
  | { type: "set_busy"; busy: boolean }
  | { type: "user_message"; text: string }
  | { type: "assistant_delta"; delta: string }
  | { type: "assistant_complete" }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_close" }
  | { type: "tool_call"; toolName: string; args: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; resultText: string; isError?: boolean }
  | { type: "turn_footer"; model: string; durationMs: number; stats?: MemoryBannerStats }
  | { type: "system_lines"; lines: string[] }
  | { type: "memory_banner"; text: string }
  | { type: "interrupted" }
  | { type: "error"; message: string }
  | { type: "bootstrap"; entries: TranscriptEntry[] };

export function createInitialTranscriptState(): TranscriptState {
  return {
    completed: [],
    live: null,
    nextId: 1,
    liveKind: null,
    busy: false,
    groupCounter: 0,
  };
}

function nextId(state: TranscriptState): [string, TranscriptState] {
  const id = `m-${state.nextId}`;
  return [id, { ...state, nextId: state.nextId + 1 }];
}

function pushCompleted(
  state: TranscriptState,
  entry: Omit<TranscriptEntry, "id" | "group">
): TranscriptState {
  const [id, s] = nextId(state);
  return {
    ...s,
    completed: [...s.completed, { ...entry, id, group: state.groupCounter }],
  };
}

function freezeLive(state: TranscriptState): TranscriptState {
  if (!state.live) return state;
  return {
    ...state,
    completed: [...state.completed, state.live],
    live: null,
    liveKind: null,
  };
}

/** Drop a live assistant entry without pushing empty rows into completed. */
function clearEmptyAssistantLive(state: TranscriptState): TranscriptState {
  if (state.liveKind !== "assistant" || !state.live || state.live.text.trim()) {
    return state;
  }
  return { ...state, live: null, liveKind: null };
}

/** Drop brief pre-tool narration ("Let me check…") that clutters tool loops. */
export const SHORT_PRE_TOOL_NARRATION_MAX = 100;

function clearShortAssistantLive(state: TranscriptState): TranscriptState {
  if (state.liveKind !== "assistant" || !state.live) return state;
  const text = state.live.text.trim();
  if (!text || text.length >= SHORT_PRE_TOOL_NARRATION_MAX) return state;
  return { ...state, live: null, liveKind: null };
}

function ensureAssistantPlaceholder(state: TranscriptState): TranscriptState {
  if (state.live) return state;
  const [id, s] = nextId(state);
  return {
    ...s,
    liveKind: "assistant",
    live: { id, role: "assistant", text: "", group: state.groupCounter },
  };
}

export function transcriptReducer(
  state: TranscriptState,
  action: TranscriptAction
): TranscriptState {
  switch (action.type) {
    case "set_busy":
      return { ...state, busy: action.busy };

    case "bootstrap":
      return {
        ...state,
        completed: action.entries,
        nextId: action.entries.length + 1,
      };

    case "user_message":
      return pushCompleted(
        { ...state, groupCounter: state.groupCounter + 1 },
        { role: "user", text: action.text }
      );

    case "assistant_delta": {
      if (state.liveKind === "assistant" && state.live) {
        return {
          ...state,
          live: { ...state.live, text: state.live.text + action.delta },
        };
      }
      const base = freezeLive(state);
      const [id, s] = nextId(base);
      return {
        ...s,
        liveKind: "assistant",
        live: { id, role: "assistant", text: action.delta, group: state.groupCounter },
      };
    }

    case "assistant_complete": {
      // If there's no live entry or a thinking entry, no-op
      if (!state.live || state.liveKind !== "assistant") return state;
      // If the live assistant entry has no text, silently drop it
      if (!state.live.text.trim()) {
        return { ...state, live: null, liveKind: null };
      }
      return {
        ...state,
        completed: [...state.completed, state.live],
        live: null,
        liveKind: null,
      };
    }

    case "thinking_delta": {
      if (state.liveKind === "thinking" && state.live) {
        return {
          ...state,
          live: { ...state.live, text: state.live.text + action.delta },
        };
      }
      let base = state;
      if (state.liveKind === "assistant" && state.live) {
        base = state.live.text.trim() ? freezeLive(state) : clearEmptyAssistantLive(state);
      }
      const [id, s] = nextId(base);
      return {
        ...s,
        liveKind: "thinking",
        live: {
          id,
          role: "thinking",
          text: action.delta,
          group: state.groupCounter,
          thinkingStartedAt: Date.now(),
        },
      };
    }

    case "thinking_close": {
      if (state.liveKind !== "thinking" || !state.live) return state;
      const text = state.live.text.trim();
      if (!text) {
        return { ...state, live: null, liveKind: null };
      }
      const durationMs =
        state.live.thinkingStartedAt !== undefined
          ? Date.now() - state.live.thinkingStartedAt
          : undefined;
      const completedThinking: TranscriptEntry = {
        ...state.live,
        text: state.live.text,
        durationMs,
      };
      // Freeze thinking to completed and immediately create an empty assistant
      // placeholder so the live area is never null (prevents flash when tools start).
      const frozen = {
        ...state,
        completed: [...state.completed, completedThinking],
        live: null,
        liveKind: null,
      };
      const [id, s] = nextId(frozen);
      return {
        ...s,
        liveKind: "assistant",
        live: { id, role: "assistant", text: "", group: state.groupCounter },
      };
    }

    case "tool_call": {
      const display = formatToolDisplay(action.toolName, action.args);
      let base = clearShortAssistantLive(state);
      base = ensureAssistantPlaceholder(base);
      const summary = summarizeArgs(action.toolName, action.args);
      return pushCompleted(base, {
        role: "tool",
        toolName: action.toolName,
        text: summary ? `${action.toolName} :: ${summary}` : action.toolName,
        toolIcon: display.icon,
        toolLabel: display.label,
        toolPending: display.pending,
      });
    }

    case "tool_result": {
      const shellDisplay =
        action.toolName === "shell"
          ? formatShellOutputForDisplay(action.resultText)
          : null;
      const summary =
        shellDisplay?.summary ?? summarizeResultForDisplay(action.resultText);
      const completed = [...state.completed];
      for (let i = completed.length - 1; i >= 0; i--) {
        const entry = completed[i];
        if (
          entry?.role === "tool" &&
          entry.toolName === action.toolName &&
          entry.resultSummary === undefined
        ) {
          completed[i] = {
            ...entry,
            resultSummary: shellDisplay?.summary ?? summary,
            resultText: action.resultText,
            resultBody: shellDisplay?.body ?? undefined,
            isError: action.isError || (shellDisplay?.isError ?? false),
          };
          return { ...state, completed };
        }
      }
      return pushCompleted(state, {
        role: "tool_result",
        toolName: action.toolName,
        text: action.resultText,
        resultSummary: shellDisplay?.summary ?? summary,
        resultText: action.resultText,
        resultBody: shellDisplay?.body ?? undefined,
        isError: action.isError || (shellDisplay?.isError ?? false),
      });
    }

    case "turn_footer":
      return pushCompleted(state, {
        role: "turn_footer",
        text: formatTurnFooter(action.model, action.durationMs, action.stats),
      });

    case "system_lines": {
      const text = action.lines.filter(Boolean).join("\n");
      if (!text) return state;
      return pushCompleted(freezeLive(state), { role: "system", text });
    }

    case "memory_banner": {
      if (!action.text) return state;
      return pushCompleted(state, { role: "system", text: action.text });
    }

    case "interrupted":
      return pushCompleted(freezeLive(state), {
        role: "system",
        text: "[interrupted]",
      });

    case "error":
      return pushCompleted(freezeLive(state), {
        role: "system",
        text: `[error] ${action.message}`,
      });

    default:
      return state;
  }
}

function fmtToken(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatMemoryBannerLine(stats: {
  activeState: number;
  totalState: number;
  digestLen: number;
  recallCalls: number;
  recallHits: number;
  autoHydrated: number;
  promptTokens: number;
  outputTokens: number;
}): string {
  if (
    stats.activeState === 0 &&
    stats.recallCalls === 0 &&
    stats.autoHydrated === 0 &&
    stats.digestLen === 0 &&
    !stats.promptTokens &&
    !stats.outputTokens
  ) {
    return "";
  }
  const parts: string[] = [];
  if (stats.activeState > 0 || stats.totalState > 0) {
    parts.push(`state ${stats.activeState}/${stats.totalState}`);
  }
  if (stats.digestLen > 0) parts.push(`digest ${stats.digestLen}c`);
  if (stats.recallCalls > 0) parts.push(`recall ${stats.recallHits}/${stats.recallCalls}`);
  if (stats.autoHydrated > 0) parts.push(`auto+${stats.autoHydrated}`);
  if (stats.promptTokens > 0) parts.push(`prompt ~${fmtToken(stats.promptTokens)}`);
  if (stats.outputTokens > 0) parts.push(`out ~${fmtToken(stats.outputTokens)}`);
  if (parts.length === 0) return "";
  return parts.join(" · ");
}
