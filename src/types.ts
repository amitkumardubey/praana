// ============================================================
// ARIA — Core Types
// ============================================================

// ---- State Objects ----

export type StateObjectKind = "task" | "decision" | "constraint" | "note";
export type StateTier = "active" | "soft" | "hard";

export interface TaskPayload {
  title: string;
  description?: string;
  status: "todo" | "doing" | "done";
}

export interface DecisionPayload {
  summary: string;
  rationale: string;
}

export interface ConstraintPayload {
  text: string;
}

export interface NotePayload {
  text: string;
}

export type StatePayload =
  | TaskPayload
  | DecisionPayload
  | ConstraintPayload
  | NotePayload;

export interface StateObject {
  id: string; // ULID
  kind: StateObjectKind;
  tier: StateTier;
  payload: StatePayload;
  created: number; // unix ms
  updated: number; // unix ms
  lastTouched: number; // unix ms, for idle-timer tier management
  focused?: boolean;
}

// ---- Event Log ----

export type EventKind =
  | "user_message"
  | "agent_message"
  | "tool_call"
  | "tool_result"
  | "context_action"
  | "system_note";

export type EventActor = "user" | "agent" | "kernel" | "tool";

export interface Event {
  event_id: string; // ULID, monotonic within session
  session_id: string;
  timestamp: number; // unix ms
  kind: EventKind;
  actor: EventActor;
  payload: Record<string, unknown>;
}

// ---- Tool result types ----

export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export interface CreateTaskResult extends ToolResult {
  id?: string;
}

export interface ListStateResult extends ToolResult {
  objects?: Array<{
    id: string;
    kind: StateObjectKind;
    tier: StateTier;
    summary: string;
  }>;
}

export interface HydrateResult extends ToolResult {
  payload?: Record<string, unknown>;
}

export interface RecallResult extends ToolResult {
  entries?: Array<{
    id: string;
    kind: string;
    content: string;
    score?: number;
    confidence?: number;
    scopes?: string[];
  }>;
}

export interface RememberResult extends ToolResult {
  id?: string;
}

// ---- Config ----

export interface LlmConfig {
  provider: string;
  model: string;
  base_url?: string;
}

export type EmbedderStrategy =
  | "auto"
  | "ollama"
  | "transformers"
  | "llama-cpp"
  | "hash";

export interface MemoryConfig {
  enabled: boolean;
  /** disabled | ollama | openrouter | openai */
  summarizer: string;
  db_path?: string;
  embedder?: EmbedderStrategy;
  ollama_url?: string;
  /** Embedding model (e.g. nomic-embed-text) */
  ollama_model?: string;
  /** Chat model for session-end learnings (e.g. qwen3.5:4b). Falls back to first non-embed model from `ollama list`. */
  ollama_summarizer_model?: string;
}

export interface CompilerConfig {
  token_budget: number;
  recent_turns: number;
  recent_turns_token_budget?: number;
  /** Minimum digest score for a memory entry to appear in the prompt. */
  recall_min_score?: number;
  /** Max share of usable prompt budget for cross-session memory section. */
  memories_budget_ratio?: number;
  /** Max share of usable prompt budget for project context (AGENTS.md). */
  skills_budget_ratio?: number;
  /** Tokens reserved for model output when computing section ceilings. */
  reserved_output_tokens?: number;
}

export interface TiersConfig {
  idle_soft_after_turns: number;
  idle_hard_after_turns: number;
}

export interface SessionConfig {
  log_dir: string;
}

export interface AriaConfig {
  llm: LlmConfig;
  memory: MemoryConfig;
  compiler: CompilerConfig;
  tiers: TiersConfig;
  session: SessionConfig;
}

// ---- Session Meta ----

export interface SessionMeta {
  session_id: string;
  started_at: number;
  cwd: string;
  agent: string;
}

// ---- Compiler ----

export interface CompilerOptions {
  stateGraph: any; // StateGraph instance (circular dep, typed loosely)
  memoryDigest: string | null;
  recentEvents: Event[];
  userInput: string;
  toolSchemas: string[];
  cwd: string;
  sessionId: string;
  tokenBudget: number;
}
