import { summarizeArgs } from "../../tool-summary.js";

export type TranscriptRole = "user" | "assistant" | "system" | "tool" | "thinking";

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  text: string;
  toolName?: string;
  /** Group ID for visual turn grouping — increments on each user message */
  group: number;
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
      if (!state.live || state.liveKind !== "assistant") return state;
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
      const base = state.liveKind === "assistant" ? freezeLive(state) : state;
      const [id, s] = nextId(base);
      return {
        ...s,
        liveKind: "thinking",
        live: { id, role: "thinking", text: action.delta, group: state.groupCounter },
      };
    }

    case "thinking_close": {
      if (state.liveKind !== "thinking" || !state.live) return state;
      const text = state.live.text.trim();
      if (!text) {
        return { ...state, live: null, liveKind: null };
      }
      return {
        ...state,
        completed: [...state.completed, state.live],
        live: null,
        liveKind: null,
      };
    }

    case "tool_call": {
      const summary = summarizeArgs(action.toolName, action.args);
      return pushCompleted(freezeLive(state), {
        role: "tool",
        toolName: action.toolName,
        text: summary ? `${action.toolName} :: ${summary}` : action.toolName,
      });
    }

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
  return `state: ${parts.join(" · ")}`;
}
